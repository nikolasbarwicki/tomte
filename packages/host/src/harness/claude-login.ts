import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ResolvedCli } from "./cli.ts";

type Env = Record<string, string | undefined>;

/** How long `auth login` may take to print the sign-in URL. */
const URL_TIMEOUT_MS = 20_000;
/** How long `auth login` may take to finish once a code was pasted. */
const SUBMIT_TIMEOUT_MS = 60_000;
/** How long a sign-in waits for its code before it is dropped. */
const LOGIN_TTL_MS = 10 * 60_000;

/** The first `https://` URL in the CLI's output, which may wrap it in OSC 8 hyperlink escapes. */
const URL_PATTERN = /https:\/\/[^\s\p{Cc}]+/u;
const FAILURE_PATTERN = /Couldn't log in:[^\n]*/;

/** A sign-in of the Claude CLI started from the web UI: `auth login` waits for the code the sign-in page shows, or completes on its own through its local callback. */
export interface ClaudeLogin {
  /** Starts a sign-in, ending one still waiting first; resolves with the page to sign in at. */
  start(): Promise<{ url: string }>;
  /** Pastes the code into the waiting sign-in; resolves once the CLI accepted it, rejects with its message when it did not. */
  submit(code: string): Promise<void>;
  /** Ends the waiting sign-in, if any. */
  cancel(): void;
  /** The sign-in waiting for its code. */
  pending(): { url: string } | undefined;
}

interface Waiting {
  child: ChildProcessWithoutNullStreams;
  url: string | undefined;
  stderr: string;
  exited: Promise<number | null>;
}

/** `done` runs after every sign-in that succeeded, whether by code or on its own. */
export function createClaudeLogin(
  cli: ResolvedCli,
  env: () => Env,
  done: () => unknown,
): ClaudeLogin {
  let current: Waiting | undefined;

  const kill = (w: Waiting | undefined) => {
    if (w && w.child.exitCode === null && w.child.signalCode === null) w.child.kill();
  };

  return {
    start() {
      kill(current);
      const child = spawn(cli.path, ["auth", "login"], {
        env: env() as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: cli.needsShell,
      });
      const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
      const w: Waiting = { child, url: undefined, stderr: "", exited };
      current = w;
      const { promise, resolve, reject } = Promise.withResolvers<{ url: string }>();
      let out = "";
      const ttl = setTimeout(() => kill(w), LOGIN_TTL_MS);
      ttl.unref();
      const urlTimer = setTimeout(() => {
        kill(w);
        reject(new Error(w.stderr.trim() || "Claude CLI gave no sign-in URL"));
      }, URL_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => {
        if (w.url) return;
        out += d;
        const url = out.match(URL_PATTERN)?.[0];
        if (!url) return;
        w.url = url;
        clearTimeout(urlTimer);
        resolve({ url });
      });
      child.stderr.on("data", (d: Buffer) => (w.stderr += d));
      child.stdin.on("error", () => {});
      child.on("error", (e) => {
        w.stderr += e.message;
      });
      child.on("close", (code) => {
        clearTimeout(ttl);
        clearTimeout(urlTimer);
        if (current === w) current = undefined;
        reject(new Error(w.stderr.trim() || "Claude CLI gave no sign-in URL"));
        exit(code);
        if (code === 0) void done();
      });
      return promise;
    },
    async submit(code) {
      const w = current;
      if (!w?.url) throw new Error("No Claude sign-in is in progress");
      w.child.stdin.write(`${code}\n`);
      const timer = setTimeout(() => kill(w), SUBMIT_TIMEOUT_MS);
      const exitCode = await w.exited.finally(() => clearTimeout(timer));
      if (exitCode !== 0)
        throw new Error(w.stderr.match(FAILURE_PATTERN)?.[0] ?? "Claude sign-in failed");
    },
    cancel() {
      kill(current);
      current = undefined;
    },
    pending: () => (current?.url ? { url: current.url } : undefined),
  };
}
