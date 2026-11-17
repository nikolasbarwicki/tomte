import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeGateway, ClaudeSignIn, ModelProvider } from "@tomte/contract/api";
import { z } from "zod";

import type { HostConfig } from "../platform/config.ts";
import { hostCommand } from "../platform/launch.ts";
import { createClaudeLogin, type ClaudeLogin } from "./claude-login.ts";
import { loginShellPath, type ResolvedCli } from "./cli.ts";

/** The name and version the host reports to Claude Code and to the MCP servers it hosts. */
const APP = "tomte";
export const VERSION = "0.1.0";

/** Whether the Claude CLI holds a sign-in; see `ClaudeSignIn`. */
export type SignInState = ClaudeSignIn;

/** What the last full check found: the sign-in, its account (only while signed in) and the CLI's version. */
interface ClaudeReport {
  state: SignInState;
  account: ModelProvider["account"];
  cliVersion: string | null;
}

type Env = Record<string, string | undefined>;

/** The host variables a remote-mode CLI child inherits; everything else in the host's environment stays out. `PATH` is added separately. */
const REMOTE_ENV = ["HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"] as const;

/** The variables a custom provider sets; an inherited one never mixes with it, and a UI sign-in runs without them. */
const GATEWAY_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** How long `auth status` or `--version` may take before the answer counts as unknown. */
const STATUS_TIMEOUT_MS = 15_000;

/** A bot or routine run started while the Claude CLI is signed out. */
class SignedOut extends Error {}

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
  /** The environment for a CLI child: the host's whole environment in local mode, an allowlist in remote mode; with the custom provider applied and claude.ai connectors off. */
  env(): Env;
  /** What the last `auth status` reported; `unknown` until one has run. */
  signInState(): SignInState;
  /** What the last full check found. */
  report(): ClaudeReport;
  /** Runs `auth status` (and `--version` until it answered) and keeps the answers; one run at a time. */
  checkSignIn(): Promise<SignInState>;
  /** Remote mode only: resolves when a run may start, and rejects with `SignedOut` naming the sign-in command. A signed-out state is re-checked once first, so a sign-in made while the host runs is picked up. */
  requireSignIn(): Promise<void>;
  /** The custom provider the CLI uses instead of the sign-in, without its token. */
  gateway(): Omit<ClaudeGateway, "token"> | undefined;
  /** Sets or clears the custom provider; the next CLI child picks it up. */
  setGateway(gateway: ClaudeGateway | undefined): void;
  /** A sign-in started from the web UI. */
  login: ClaudeLogin;
  /** Ends a waiting sign-in; called when the host stops. */
  close(): void;
}

/** Runs the CLI with `args` and resolves with its stdout, or undefined when it failed. */
function run(cli: ResolvedCli, args: string[], env: Env): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let out = "";
  const p = spawn(cli.path, args, {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "ignore"],
    shell: cli.needsShell,
    timeout: STATUS_TIMEOUT_MS,
  });
  p.stdout.on("data", (d: Buffer) => (out += d));
  p.on("error", () => resolve(undefined));
  p.on("close", () => resolve(out));
  return promise;
}

/** The Claude CLI's environment and sign-in for this host. */
export function createClaudeAccess(config: HostConfig, cli: ResolvedCli): ClaudeAccess {
  let gateway: ClaudeGateway | undefined;

  const baseEnv = (): Env => {
    const child: Env = {};
    if (config.mode === "remote") {
      for (const k of REMOTE_ENV) child[k] = process.env[k];
      child.CLAUDE_CONFIG_DIR = claudeConfigDir(config);
    } else Object.assign(child, process.env);
    child.PATH = loginShellPath();
    child.CLAUDE_AGENT_SDK_CLIENT_APP = `${APP}/${VERSION}`;
    child.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    if (cli.source === "managed") child.DISABLE_AUTOUPDATER = "1";
    else delete child.DISABLE_AUTOUPDATER;
    return child;
  };

  const env = (): Env => {
    const child = baseEnv();
    if (!gateway) return child;
    for (const k of GATEWAY_ENV) delete child[k];
    child.ANTHROPIC_BASE_URL = gateway.baseUrl;
    child[gateway.auth === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = gateway.token;
    return child;
  };

  let current: ClaudeReport = { state: "unknown", account: null, cliVersion: null };
  let running: Promise<SignInState> | undefined;

  const status = async (): Promise<ClaudeReport> => {
    const childEnv = env();
    const [out, version] = await Promise.all([
      run(cli, ["auth", "status"], childEnv),
      current.cliVersion ?? run(cli, ["--version"], childEnv),
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

  const checkSignIn = () =>
    (running ??= status()
      .then((r) => (current = r).state)
      .finally(() => (running = undefined)));

  const login = createClaudeLogin(
    cli,
    () => {
      const child = baseEnv();
      for (const k of GATEWAY_ENV) delete child[k];
      return child;
    },
    checkSignIn,
  );

  return {
    env,
    signInState: () => current.state,
    report: () => current,
    checkSignIn,
    async requireSignIn() {
      if (config.mode !== "remote") return;
      if (running) await running;
      if (current.state === "signed-out") await checkSignIn();
      if (current.state === "signed-out") {
        throw new SignedOut(
          `Claude is not signed in on this host; run \`${remoteLoginCommand(config)}\` in a terminal on the host, then try again`,
        );
      }
    },
    gateway: () => gateway && { baseUrl: gateway.baseUrl, auth: gateway.auth },
    setGateway(g) {
      gateway = g;
    },
    login,
    close: () => login.cancel(),
  };
}
