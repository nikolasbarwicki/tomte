import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeGateway, ClaudeUsage, ModelProvider } from "@tomte/contract/api";
import type { ClaudeState, ClaudeStatus } from "@tomte/contract/host-status";
import { z } from "zod";

import type { HostConfig } from "../platform/config.ts";
import { hostCommand } from "../platform/launch.ts";
import { createClaudeLogin, type ClaudeLogin } from "./claude-login.ts";
import { readClaudeUsage } from "./claude-usage.ts";
import { loginShellPath, type ResolvedCli } from "./cli.ts";
import { CREDENTIAL_FD, handCredential, stdioFor, type SpawnSpec } from "./spawn.ts";

/** The name and version the host reports to Claude Code and to the MCP servers it hosts. */
const APP = "tomte";
export const VERSION = "0.1.0";

/** What the last full check found: the sign-in, its account (only while signed in) and the CLI's version. */
interface ClaudeReport {
  state: ClaudeState;
  account: ModelProvider["account"];
  cliVersion: string | null;
}

type Env = Record<string, string | undefined>;

/** The host variables a remote-mode CLI child inherits; everything else in the host's environment stays out. `PATH` is added separately. */
const REMOTE_ENV = ["HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"] as const;

/** Host environment variables that choose how the CLI is billed or signed in. No CLI child inherits them, in either mode: a custom provider is the one deliberate way to bill by API, and it sets its own. */
export const BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** The variables that carried a custom provider's token before it moved to a descriptor. The CLI no longer gets them, and `claudeHarness` still denies them to sandboxed commands, as defence in depth. */
export const GATEWAY_TOKEN_ENV = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** The variables that tell the CLI to read a credential from `CREDENTIAL_FD`, by what it is. */
const FD_VARIABLE = {
  longLivedToken: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  gatewayApiKey: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  gatewayBearer: "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
} as const;

/** How long `auth status` or `--version` may take before the answer counts as unknown. */
const STATUS_TIMEOUT_MS = 15_000;

/** How often the sign-in is asked again when nothing else asked. */
const RECHECK_MS = 10 * 60_000;

/** How long one CLI start-up may hold the gate before the next one is let through: a CLI that never answers must not stop every bot from starting. */
const START_HOLD_MS = 60_000;

/** How long changes to the CLI's credentials settle before the sign-in is asked again. */
const WATCH_DEBOUNCE_MS = 200;

/** The file the CLI writes its sign-in to where it has no keychain; a change to it is a sign-in or sign-out. */
const CREDENTIALS_FILE = ".credentials.json";

/** What made a sign-in check run; logged when it changes the state. */
type RecheckReason =
  | "startup"
  | "timer"
  | "watch"
  | "login"
  | "gateway"
  | "long-lived-token"
  | "providers"
  | "usage"
  | "require-sign-in"
  | "turn-auth-failure"
  | "host-command";

/** The checks asked because the sign-in or what it is read with just changed: one already running began too early to answer them. */
const CHANGES_THE_ANSWER: ReadonlySet<RecheckReason> = new Set([
  "login",
  "gateway",
  "long-lived-token",
  "watch",
  "turn-auth-failure",
]);

/** A bot or routine run started while the Claude CLI is signed out. */
class SignedOut extends Error {}

/** What the host keeps to know a token was rejected, never the token. */
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

/** What the CLI says when its sign-in is missing, expired or revoked, in a failed turn's error. */
const AUTH_FAILURE =
  /authentication[_ ](?:failed|error)|not logged in|please run \/login|invalid api key|oauth token (?:has )?(?:expired|revoked)|invalid bearer token|api error: 401/i;

/** Whether a failed turn's error reads as a missing, expired or revoked sign-in, so the host asks the CLI again instead of leaving it opaque. */
export function isAuthFailure(e: unknown): boolean {
  if (e instanceof SignedOut) return false;
  return AUTH_FAILURE.test(e instanceof Error ? e.message : String(e));
}

const AuthStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().nullish(),
  email: z.string().nullish(),
  orgName: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});

/** The directory the CLI keeps its sign-in and session history in: `claude/` in the data root in remote mode, else what the CLI defaults to. */
export function claudeConfigDir(config: HostConfig): string {
  if (config.mode === "remote") return join(config.dataRoot, "claude");
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The Agent SDK reads session transcripts from this process's own `CLAUDE_CONFIG_DIR`, so in remote mode the host process points it where its CLI children write them. Call once at startup. */
export function adoptClaudeConfigDir(config: HostConfig): void {
  if (config.mode === "remote") process.env.CLAUDE_CONFIG_DIR = claudeConfigDir(config);
}

/** The host command that signs the Claude CLI in, for a remote-mode host: `auth-login` parses the same configuration as the server, so it names the data root and the secrets backend too. */
export function remoteLoginCommand(config: HostConfig): string {
  const secrets =
    config.secrets.backend === "file"
      ? ["--secrets-key-file", config.secrets.keyFile]
      : ["--secrets", "keychain"];
  return hostCommand("auth-login", "--mode", "remote", "--data-root", config.dataRoot, ...secrets);
}

/** Every Claude CLI child the host starts. */
export interface ClaudeAccess {
  /** What a CLI child is started with: the host's environment in local mode, an allowlist in remote mode; never a `BILLING_ENV` variable of the host's, with claude.ai connectors off. The long-lived token or the custom provider's token is the `credential`, on a descriptor the environment names, never in the environment. */
  spawnSpec(): SpawnSpec;
  /** What the host knows of the sign-in now: `unknown` until a check has answered, and a later `unknown` answer never replaces a known state. A long-lived token that a CLI turn failed to authenticate with makes it `signed-out` with reason `token-rejected` until the token is replaced or removed; `auth status` cannot undo that. */
  status(): ClaudeStatus;
  /** Calls `listener` when the state or the method of `status()` changes, not when a check finds the same; returns the way to stop. */
  onChange(listener: (status: ClaudeStatus) => void): () => void;
  /** What the last full check found; while the long-lived token is rejected it reads signed out with no account, whatever `auth status` said. */
  report(): ClaudeReport;
  /** Runs `start` once every earlier start has finished, so one CLI start-up (where an expired access token is refreshed) happens at a time host-wide. Resolves and rejects as `start` does; a failed start does not hold the next one back. Hold it only until the CLI has answered its initialize request, and never call it from inside `start`. */
  startGate<T>(start: () => Promise<T>): Promise<T>;
  /** Runs `auth status` (and `--version` until it answered) and keeps the answers; one run at a time, whoever asks. */
  recheck(reason: RecheckReason): Promise<ClaudeStatus>;
  /** Checks now, then on a timer and whenever the CLI's credentials change on disk, so a sign-in or sign-out made outside Tomte shows up; `close()` stops it. */
  start(): void;
  /** The subscription's plan usage (session and weekly limits) as the CLI reports it now; unavailable without a sign-in or with a custom provider. One check at a time; rejects when the CLI cannot answer. */
  usage(): Promise<ClaudeUsage>;
  /** Remote mode only: resolves when a run may start, and rejects with `SignedOut` naming the sign-in command. A signed-out state is re-checked once first, so a sign-in made while the host runs is picked up. */
  requireSignIn(): Promise<void>;
  /** The custom provider the CLI uses instead of the sign-in, without its token. */
  gateway(): Omit<ClaudeGateway, "token"> | undefined;
  /** Sets or clears the custom provider; the next CLI child picks it up. */
  setGateway(gateway: ClaudeGateway | undefined): void;
  /** Whether a long-lived token is set. */
  hasLongLivedToken(): boolean;
  /** Sets or clears the long-lived token (from `claude setup-token`) the CLI uses instead of its sign-in; the next CLI child picks it up. Replacing or clearing it ends a rejection. `rejectedDigest` (from `onTokenRejected`) is how a host that restarts says this very token was rejected before. The caller keeps the token in the secrets backend. */
  setLongLivedToken(token: string | undefined, rejectedDigest?: string): void;
  /** A sign-in started from the web UI. */
  login: ClaudeLogin;
  /** Stops the checks and ends a waiting sign-in; called when the host stops. */
  close(): void;
}

/** Runs the CLI with `args` and resolves with its stdout, or undefined when it failed. */
function run(cli: ResolvedCli, args: string[], spec: SpawnSpec): Promise<string | undefined> {
  if (spec.credential !== undefined && cli.needsShell) return Promise.resolve(undefined);
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let out = "";
  const p = spawn(cli.path, args, {
    env: spec.env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "ignore", ...stdioFor(spec)],
    shell: cli.needsShell,
    timeout: STATUS_TIMEOUT_MS,
  });
  handCredential(p, spec);
  p.stdout?.on("data", (d: Buffer) => (out += d));
  p.on("error", () => resolve(undefined));
  p.on("close", () => resolve(out));
  return promise;
}

/** The Claude CLI's environment and sign-in for this host. */
export function createClaudeAccess(
  config: HostConfig,
  cli: ResolvedCli,
  o: {
    recheckMs?: number;
    startHoldMs?: number;
    /** Called once when a CLI turn's authentication failure marks the long-lived token rejected, with the token's digest; the host keeps it so a restart with the same token starts out rejected. */
    onTokenRejected?: (digest: string) => void;
  } = {},
): ClaudeAccess {
  let gateway: ClaudeGateway | undefined;
  let longLivedToken: string | undefined;
  /** Whether a CLI turn refused `longLivedToken`; kept in memory and, through `onTokenRejected`, as a digest of the token. */
  let tokenRejected = false;

  /** Which billing variables the host started with; they are dropped from every child, and Settings names them. */
  const ignoredEnv = BILLING_ENV.filter((k) => process.env[k]);

  const baseEnv = (): Env => {
    const child: Env = {};
    if (config.mode === "remote") {
      for (const k of REMOTE_ENV) child[k] = process.env[k];
      child.CLAUDE_CONFIG_DIR = claudeConfigDir(config);
    } else Object.assign(child, process.env);
    for (const k of BILLING_ENV) delete child[k];
    child.PATH = loginShellPath();
    child.CLAUDE_AGENT_SDK_CLIENT_APP = `${APP}/${VERSION}`;
    child.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    if (cli.source === "managed") child.DISABLE_AUTOUPDATER = "1";
    else delete child.DISABLE_AUTOUPDATER;
    return child;
  };

  const spawnSpec = (): SpawnSpec => {
    const env = baseEnv();
    const fd = String(CREDENTIAL_FD);
    if (gateway) {
      env.ANTHROPIC_BASE_URL = gateway.baseUrl;
      if (gateway.auth === "api_key") env[FD_VARIABLE.gatewayApiKey] = fd;
      else {
        env.CLAUDE_CODE_USE_GATEWAY = "1";
        env[FD_VARIABLE.gatewayBearer] = fd;
      }
      return { env, credential: gateway.token };
    }
    if (longLivedToken === undefined) return { env };
    env[FD_VARIABLE.longLivedToken] = fd;
    return { env, credential: longLivedToken };
  };

  /** Resolves when `start` has settled, or after `holdMs`, whichever comes first; never rejects. */
  const held = async (start: Promise<unknown>, holdMs: number): Promise<void> => {
    const { promise: expired, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, holdMs);
    timer.unref();
    try {
      await Promise.race([start, expired]);
    } catch {
      // The caller of `start` sees its failure; the gate only needs it over.
    } finally {
      clearTimeout(timer);
    }
  };
  let tail: Promise<void> = Promise.resolve();
  const startGate = <T>(start: () => Promise<T>): Promise<T> => {
    const result = tail.then(start);
    // Both continuations run when the starts in front are over, so the hold is counted from when this start begins, not from when it queued.
    tail = tail.then(() => held(result, o.startHoldMs ?? START_HOLD_MS));
    return result;
  };

  let current: ClaudeReport = { state: "unknown", account: null, cliVersion: null };
  let lastChecked = 0;
  let running: Promise<ClaudeStatus> | undefined;
  const listeners = new Set<(status: ClaudeStatus) => void>();

  const status = (): ClaudeStatus => {
    const rejected = tokenRejected && !gateway;
    const method = gateway
      ? "custom-provider"
      : longLivedToken !== undefined
        ? "long-lived-token"
        : current.state === "signed-in" && current.account?.method === "claude.ai"
          ? "subscription"
          : undefined;
    return {
      state: rejected ? "signed-out" : current.state,
      ...(method && { method }),
      ignoredEnv: [...ignoredEnv],
      checkedAt: lastChecked,
      ...(rejected && { reason: "token-rejected" as const }),
    };
  };

  let announced = "unknown/";
  const announce = (reason: RecheckReason) => {
    const s = status();
    const key = `${s.state}/${s.method ?? ""}`;
    if (key === announced) return;
    // The first answer is not news; a sign-in that came or went is.
    if (!announced.startsWith("unknown/"))
      console.error(`[claude] sign-in is ${s.state} (${reason})`);
    announced = key;
    for (const l of listeners) {
      try {
        l(s);
      } catch (e) {
        console.error(`[claude] a status listener failed: ${(e as Error).message}`);
      }
    }
  };

  const probe = async (): Promise<ClaudeReport> => {
    const spec = spawnSpec();
    const [out, version] = await Promise.all([
      run(cli, ["auth", "status"], spec),
      current.cliVersion ?? run(cli, ["--version"], { env: baseEnv() }),
    ]);
    const cliVersion = version?.trim().split(/\s+/)[0] || null;
    try {
      const s = AuthStatus.parse(JSON.parse(out ?? ""));
      return {
        state: s.loggedIn ? "signed-in" : "signed-out",
        account: s.loggedIn
          ? {
              method: s.authMethod ?? "unknown",
              email: s.email ?? null,
              organization: s.orgName ?? null,
              plan: s.subscriptionType ?? null,
            }
          : null,
        cliVersion,
      };
    } catch {
      return { state: "unknown", account: null, cliVersion };
    }
  };

  /** Bumped when something the answer depends on changed, so a check already running (which began before it) is not taken for an answer. */
  let world = 0;
  const probeFresh = async (): Promise<ClaudeReport> => {
    for (;;) {
      const seen = world;
      const r = await startGate(probe);
      if (seen === world) return r;
    }
  };

  /** The long-lived token was refused by a CLI turn: only the CLI's own `auth status` could say otherwise, and it says signed in for any string, so this stands until the token is replaced or removed. */
  const rejectToken = () => {
    if (tokenRejected || gateway || longLivedToken === undefined) return;
    tokenRejected = true;
    o.onTokenRejected?.(tokenDigest(longLivedToken));
    announce("turn-auth-failure");
  };

  const recheck = (reason: RecheckReason) => {
    if (reason === "turn-auth-failure") rejectToken();
    if (CHANGES_THE_ANSWER.has(reason)) world++;
    return (running ??= probeFresh()
      .then((r) => {
        // A check that could not run says nothing about a sign-in the host already knows.
        if (r.state !== "unknown" || current.state === "unknown") {
          current = r;
          lastChecked = Date.now();
        }
        announce(reason);
        return status();
      })
      .finally(() => (running = undefined)));
  };

  const login = createClaudeLogin(cli, baseEnv, () => recheck("login"));

  let watcher: FSWatcher | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** In remote mode the directory is the host's own and is made for the watch; elsewhere it may not exist yet (nobody has signed in) and the timer tries again. */
  const watchCredentials = () => {
    if (watcher) return;
    const dir = claudeConfigDir(config);
    try {
      if (config.mode === "remote") mkdirSync(dir, { recursive: true, mode: 0o700 });
      const w = watch(dir, (_event, file) => {
        if (file !== null && file.toString() !== CREDENTIALS_FILE) return;
        clearTimeout(settle);
        settle = setTimeout(() => void recheck("watch"), WATCH_DEBOUNCE_MS);
        settle.unref();
      });
      w.on("error", () => {
        w.close();
        if (watcher === w) watcher = undefined;
      });
      w.unref();
      watcher = w;
    } catch {
      watcher = undefined;
    }
  };

  let usageRunning: Promise<ClaudeUsage> | undefined;
  const readUsage = async (): Promise<ClaudeUsage> => {
    const checkedAt = Date.now();
    if (gateway || longLivedToken !== undefined || (await recheck("usage")).state !== "signed-in")
      return { available: false, windows: [], checkedAt };
    return {
      ...(await readClaudeUsage(cli, baseEnv(), config.dataRoot, startGate)),
      checkedAt,
    };
  };

  return {
    spawnSpec,
    startGate,
    status,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    report: () =>
      tokenRejected && !gateway ? { ...current, state: "signed-out", account: null } : current,
    recheck,
    start() {
      void recheck("startup");
      watchCredentials();
      timer ??= setInterval(() => {
        watchCredentials();
        void recheck("timer");
      }, o.recheckMs ?? RECHECK_MS);
      timer.unref();
    },
    usage: () => (usageRunning ??= readUsage().finally(() => (usageRunning = undefined))),
    async requireSignIn() {
      if (config.mode !== "remote") return;
      if (tokenRejected && !gateway) {
        throw new SignedOut(
          "Claude rejected the long-lived token on this host; replace it in Settings, Models, then try again",
        );
      }
      if (running) await running;
      if (current.state === "signed-out") await recheck("require-sign-in");
      if (current.state === "signed-out") {
        throw new SignedOut(
          `Claude is not signed in on this host; run \`${remoteLoginCommand(config)}\` in a terminal on the host, then try again`,
        );
      }
    },
    gateway: () => gateway && { baseUrl: gateway.baseUrl, auth: gateway.auth },
    setGateway(g) {
      gateway = g;
      announce("gateway");
      void recheck("gateway");
    },
    hasLongLivedToken: () => longLivedToken !== undefined,
    setLongLivedToken(token, rejectedDigest) {
      longLivedToken = token;
      tokenRejected = token !== undefined && rejectedDigest === tokenDigest(token);
      announce("long-lived-token");
      void recheck("long-lived-token");
    },
    login,
    close() {
      clearInterval(timer);
      timer = undefined;
      clearTimeout(settle);
      watcher?.close();
      watcher = undefined;
      login.cancel();
    },
  };
}
