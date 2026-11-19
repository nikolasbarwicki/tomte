import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BILLING_ENV } from "../harness/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

// Each test starts a whole host and runs the CLI several times.
setDefaultTimeout(60_000);

const KEY_FILE = "/etc/tomte-test/secrets.key";
const MODES = {
  remote: ["--mode", "remote", "--secrets-key-file", KEY_FILE],
  local: [],
} as const;

const ENV_KEYS = [...BILLING_ENV, "CLAUDE_CONFIG_DIR"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A key in the developer's environment would show up as an ignored variable.
beforeEach(() => {
  for (const k of BILLING_ENV) delete process.env[k];
});

let host: HandoffHost | undefined;
let watcher: EventsWatch | undefined;
let temp: string;

/** The directory the host's CLI keeps its sign-in in, which the host watches. */
let configDir: string;

async function start(
  mode: keyof typeof MODES,
  timing: Parameters<typeof startHandoffHost>[3] = {},
) {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "claude-status-")));
  // Local mode reads the CLI's directory from the host process's environment; remote mode keeps it in the data root.
  process.env.CLAUDE_CONFIG_DIR = join(temp, "host-process-claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  host = await startHandoffHost([...MODES[mode]], undefined, undefined, timing);
  configDir = mode === "remote" ? join(host.dataRoot, "claude") : process.env.CLAUDE_CONFIG_DIR;
  return host;
}

afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await host?.stop();
  host = undefined;
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(temp, { recursive: true, force: true });
});

const claudeOf = (w: EventsWatch) => w.hostStatus()?.claude;

/** What the CLI does when it signs in or out: it rewrites its credentials file. */
const credentialsChanged = () =>
  writeFileSync(join(configDir, ".credentials.json"), String(Math.random()));

describe.each(["remote", "local"] as const)("%s mode", (mode) => {
  test("a page that connects gets the host's status with the sign-in as the CLI reports it", async () => {
    const h = await start(mode);
    await h.until(() => h.server.signInState() === "signed-in");
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!) !== undefined);

    const status = watcher.hostStatus()!;
    expect(status.mode).toBe(mode);
    expect(status.update.status).toBe("unmanaged");
    expect(status.claude).toMatchObject({ state: "signed-in", method: "subscription" });
    expect(status.claude.ignoredEnv).toEqual([]);
    expect(status.claude.checkedAt).toBeGreaterThan(0);
  });

  test("billing variables in the host's environment are named as ignored and never sign the CLI in", async () => {
    // The fake CLI, like the real one, would report signed in through either of these.
    process.env.ANTHROPIC_API_KEY = "synthetic-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-token";
    const h = await start(mode);
    h.setSignedIn(false);
    await h.restart();
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!)?.state === "signed-out");

    expect(claudeOf(watcher)?.ignoredEnv).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  });

  test("a sign-out and a sign-in made outside the host reach the stream within one watch tick, and other files in the directory change nothing", async () => {
    const h = await start(mode);
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!)?.state === "signed-in");

    h.setSignedIn(false);
    writeFileSync(join(configDir, "history.jsonl"), "a bot turn wrote this\n");
    // Nothing is awaited here by design: this is the longest a wrongly triggered check would need to show (debounce 200 ms plus a CLI run).
    await Bun.sleep(500);
    expect(claudeOf(watcher)?.state).toBe("signed-in");

    credentialsChanged();
    await h.until(() => claudeOf(watcher!)?.state === "signed-out", 3000);
    expect(claudeOf(watcher)?.method).toBeUndefined();

    h.setSignedIn(true);
    credentialsChanged();
    await h.until(() => claudeOf(watcher!)?.state === "signed-in", 3000);
    expect(claudeOf(watcher)?.method).toBe("subscription");
  });

  test("a sign-out the host cannot see on disk shows on the timer", async () => {
    const h = await start(mode, { claudeRecheckMs: 100 });
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!)?.state === "signed-in");

    h.setSignedIn(false);
    await h.until(() => claudeOf(watcher!)?.state === "signed-out", 3000);
    h.setSignedIn(true);
    await h.until(() => claudeOf(watcher!)?.state === "signed-in", 3000);
  });

  test("a turn that fails because the sign-in is gone makes the host ask again, and still fails", async () => {
    const h = await start(mode);
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!)?.state === "signed-in");
    const bot = h.createBot("Ada");
    expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);

    h.setSignedIn(false);
    h.setUsage({ cost: 0.1, error: "Invalid API key · Please run /login" });
    expect((await h.ui("/api/send", { text: "hello" })).status).toBe(200);

    await h.until(() => claudeOf(watcher!)?.state === "signed-out", 3000);
    const error = watcher.events().find((e) => e.type === "error");
    expect(error?.message).toContain("Please run /login");
  });

  test("a turn that fails for another reason leaves the sign-in alone", async () => {
    const h = await start(mode);
    watcher = await watchEvents(h);
    await h.until(() => claudeOf(watcher!)?.state === "signed-in");
    const bot = h.createBot("Ada");
    expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);

    h.setSignedIn(false);
    h.setUsage({ cost: 0.1, error: "the model gave up" });
    expect((await h.ui("/api/send", { text: "hello" })).status).toBe(200);

    await h.until(() => watcher!.events().some((e) => e.type === "error"), 3000);
    // As above: a check a failed turn wrongly triggered would have answered within this.
    await Bun.sleep(300);
    expect(claudeOf(watcher)?.state).toBe("signed-in");
  });
});
