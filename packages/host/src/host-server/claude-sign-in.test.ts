import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const PRETEND_LINUX = join(import.meta.dir, "..", "testing", "pretend-linux.ts");
const KEY_FILE = "/etc/tomte-test/secrets.key";
const REMOTE = ["--mode", "remote", "--secrets-key-file", KEY_FILE];

/** The variable names the CLI may start with in remote mode: what the host gives it, plus what the SDK and the test wrapper add. */
const ALLOWED = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
  // Added by the Agent SDK to every CLI it starts.
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SDK_READS_SESSION_STATE",
  // The bot's own events route and token (ADR-0007), added on top of the allowlist for that bot only.
  "TOMTE_EVENTS_URL",
  "TOMTE_EVENTS_TOKEN",
  // Added by the test host's /bin/sh wrapper around the fake CLI.
  "PWD",
  "SHLVL",
];

/** Host process variables the CLI must never see. */
const HOST_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-synthetic-test-key",
  CREDENTIALS_DIRECTORY: "/run/credentials/tomte.service",
  JUNK_FOR_TEST: "junk-value",
};

let host: HandoffHost | undefined;
let temp: string;
const saved = Object.fromEntries(
  [...Object.keys(HOST_SECRETS), "CLAUDE_CONFIG_DIR", "SENTINEL_FOR_TEST"].map((k) => [
    k,
    process.env[k],
  ]),
);

async function start(flags: string[], env: Record<string, string> = {}) {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "claude-sign-in-")));
  // The Agent SDK reads transcripts from this process's own config directory; keep it away from the real one.
  process.env.CLAUDE_CONFIG_DIR = join(temp, "host-process-claude");
  Object.assign(process.env, env);
  host = await startHandoffHost(flags);
  return host;
}

afterEach(async () => {
  await host?.stop();
  host = undefined;
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(temp, { recursive: true, force: true });
});

/** Runs a host subcommand against the fake CLI the way an operator does over SSH. */
async function runHost(h: HandoffHost, args: string[]) {
  const p = Bun.spawn([process.execPath, "--preload", PRETEND_LINUX, MAIN, ...args], {
    env: { ...process.env, CLAUDE_PATH: h.cliPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, stderr };
}

/** The first error the open bot's chat shows, read from the event stream's replay once it appears. */
async function chatError(h: HandoffHost): Promise<string> {
  const ctl = new AbortController();
  const res = await fetch(`${h.clientUrl}/api/events`, {
    signal: ctl.signal,
    headers: h.authHeaders,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    // A read can end inside an event; only the events before the last blank line are whole.
    const error = text
      .split("\n\n")
      .slice(0, -1)
      .filter((l) => l.startsWith("data: "))
      .flatMap((l) => eventsOf(l.slice(6)) as { type: string; message?: string }[])
      .find((e) => e.type === "error");
    if (error) {
      ctl.abort();
      return error.message ?? "";
    }
  }
  ctl.abort();
  throw new Error("the chat showed no error");
}

async function chat(h: HandoffHost, text: string) {
  const bot = h.createBot("Ada");
  expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await h.ui("/api/send", { text })).status).toBe(200);
  return bot;
}

describe("remote mode", () => {
  test("the CLI gets an allowlisted environment with the sign-in in the data root", async () => {
    const h = await start(REMOTE, HOST_SECRETS);
    const bot = await chat(h, "hello");
    await h.until(() => h.messagesOf(bot).length === 1);

    const [launch] = h.launches();
    const env = launch!.env;
    expect(Object.keys(env).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(h.dataRoot, "claude"));
    expect(env.PATH).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env).some((v) => v.includes(KEY_FILE))).toBe(false);
  });

  test("a run while signed out fails naming the sign-in command, and a later sign-in needs no restart", async () => {
    const h = await start(REMOTE);
    h.setSignedIn(false);
    await h.restart();
    await h.until(() => h.server.signInState() === "signed-out");

    const bot = await chat(h, "hello");
    const error = await chatError(h);
    expect(error).toContain(`--data-root ${h.dataRoot}`);
    // The operator signs in, then runs the command exactly as the error gave it.
    const suggested = /`([^`]+)`/.exec(error)![1]!.split(" ");
    h.setSignedIn(true);
    expect((await runHost(h, suggested.slice(suggested.indexOf("auth-login")))).code).toBe(0);
    expect(h.messagesOf(bot)).toEqual([]);

    expect((await h.ui("/api/send", { text: "again" })).status).toBe(200);
    await h.until(() => h.messagesOf(bot).length === 1);
    expect(h.server.signInState()).toBe("signed-in");
  });
});

describe("local mode", () => {
  test("the CLI still gets the host's whole environment and the host never checks the sign-in", async () => {
    const h = await start([], { ...HOST_SECRETS, SENTINEL_FOR_TEST: "reaches-the-cli" });
    h.setSignedIn(false);
    await h.restart();
    const bot = await chat(h, "hello");
    await h.until(() => h.messagesOf(bot).length === 1);

    const env = h.launches()[0]!.env;
    expect(env.SENTINEL_FOR_TEST).toBe("reaches-the-cli");
    expect(env.JUNK_FOR_TEST).toBe("junk-value");
    expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR!);
    expect(h.server.signInState()).toBe("unknown");
  });
});

describe("host auth-login and auth-status", () => {
  const subcommand = (h: HandoffHost, name: string) =>
    runHost(h, [name, "--data-root", h.dataRoot, ...REMOTE]);

  test("login succeeds when the fresh status shows the sign-in", async () => {
    const h = await start(REMOTE);
    expect((await subcommand(h, "auth-login")).code).toBe(0);
  });

  test("login fails when the sign-in is not visible to the host", async () => {
    const h = await start(REMOTE);
    h.setSignedIn(false);
    const r = await subcommand(h, "auth-login");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("not visible to the host");
    expect(r.stderr).toContain(join(h.dataRoot, "claude"));
  });

  test("a failed login keeps its exit code", async () => {
    const h = await start(REMOTE);
    h.setLoginExit(3);
    expect((await subcommand(h, "auth-login")).code).toBe(3);
  });

  test("status exits non-zero while signed out", async () => {
    const h = await start(REMOTE);
    expect((await subcommand(h, "auth-status")).code).toBe(0);
    h.setSignedIn(false);
    expect((await subcommand(h, "auth-status")).code).toBe(1);
  });
});
