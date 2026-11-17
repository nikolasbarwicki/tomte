import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeSignIn } from "@tomte/contract/api";
import { z } from "zod";

import type { HostConfig } from "../platform/config.ts";
import { hostCommand } from "../platform/launch.ts";
import { loginShellPath, type ResolvedCli } from "./cli.ts";

/** The name and version the host reports to Claude Code and to the MCP servers it hosts. */
const APP = "tomte";
export const VERSION = "0.1.0";

/** Whether the Claude CLI holds a sign-in; see `ClaudeSignIn`. */
export type SignInState = ClaudeSignIn;

type Env = Record<string, string | undefined>;

/** The host variables a remote-mode CLI child inherits; everything else in the host's environment stays out. `PATH` is added separately. */
const REMOTE_ENV = ["HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"] as const;

/** How long `auth status` may take before the sign-in counts as unknown. */
const STATUS_TIMEOUT_MS = 15_000;

/** A bot or routine run started while the Claude CLI is signed out. */
class SignedOut extends Error {}

const AuthStatus = z.object({ loggedIn: z.boolean() });

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
  /** The environment for a CLI child: the host's whole environment in local mode, an allowlist in remote mode. */
  env(): Env;
  /** What the last `auth status` reported; `unknown` until one has run. */
  signInState(): SignInState;
  /** Runs `auth status` and keeps its answer; one run at a time. */
  checkSignIn(): Promise<SignInState>;
  /** Remote mode only: resolves when a run may start, and rejects with `SignedOut` naming the sign-in command. A signed-out state is re-checked once first, so a sign-in made while the host runs is picked up. */
  requireSignIn(): Promise<void>;
}

/** The Claude CLI's environment and sign-in for this host. */
export function createClaudeAccess(config: HostConfig, cli: ResolvedCli): ClaudeAccess {
  const env = (): Env => {
    const child: Env = {};
    if (config.mode === "remote") {
      for (const k of REMOTE_ENV) child[k] = process.env[k];
      child.CLAUDE_CONFIG_DIR = claudeConfigDir(config);
    } else Object.assign(child, process.env);
    child.PATH = loginShellPath();
    child.CLAUDE_AGENT_SDK_CLIENT_APP = `${APP}/${VERSION}`;
    if (cli.source === "managed") child.DISABLE_AUTOUPDATER = "1";
    else delete child.DISABLE_AUTOUPDATER;
    return child;
  };

  let state: SignInState = "unknown";
  let running: Promise<SignInState> | undefined;

  const status = () => {
    const { promise, resolve } = Promise.withResolvers<SignInState>();
    let out = "";
    const p = spawn(cli.path, ["auth", "status"], {
      env: env() as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      shell: cli.needsShell,
      timeout: STATUS_TIMEOUT_MS,
    });
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.on("error", () => resolve("unknown"));
    p.on("close", () => {
      try {
        const { loggedIn } = AuthStatus.parse(JSON.parse(out));
        resolve(loggedIn ? "signed-in" : "signed-out");
      } catch {
        resolve("unknown");
      }
    });
    return promise;
  };

  const checkSignIn = () =>
    (running ??= status()
      .then((s) => (state = s))
      .finally(() => (running = undefined)));

  return {
    env,
    signInState: () => state,
    checkSignIn,
    async requireSignIn() {
      if (config.mode !== "remote") return;
      if (running) await running;
      if (state === "signed-out") await checkSignIn();
      if (state === "signed-out") {
        throw new SignedOut(
          `Claude is not signed in on this host; run \`${remoteLoginCommand(config)}\` in a terminal on the host, then try again`,
        );
      }
    },
  };
}
