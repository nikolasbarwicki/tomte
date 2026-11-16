import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBot } from "../bots/index.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import { parseHostConfig } from "../platform/config.ts";
import { migrate } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { defined } from "../testing/defined.ts";
import { clientPost, pairDevice } from "../testing/paired-device.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "testing", "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "..", "testing", "fake-claude.ts");
const ENV_KEYS = [
  "AGENT_BROWSER_PATH",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "FAKE_CLAUDE_DIR",
] as const;
const UNATTENDED =
  "not available in unattended runs; report the login wall or CAPTCHA in your result instead";
const DAY = 24 * 60 * 60_000;

let root: string;
let cwd: string;
let fakeDir: string;
let claudeDir: string;
let server: HostServer;
let device: string;
let db: Database;
let clock = Date.now();
let serverOptions: { script: object; laneWaitMs?: number | undefined };
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const closers: (() => unknown)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "routines-browser-test-")));
  const chrome = join(root, "chrome");
  writeFileSync(chrome, "");
  process.env.AGENT_BROWSER_PATH = FAKE_ENGINE;
  process.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
});

afterAll(() => {
  for (const k of ENV_KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  cwd = join(root, `ws-${Math.random().toString(36).slice(2)}`);
  fakeDir = join(cwd, "fake");
  claudeDir = join(cwd, "claude");
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  process.env.FAKE_CLAUDE_DIR = claudeDir;
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  rmSync(join(claudeDir, "hold"), { force: true });
  await server.close();
});

const makeServer = () =>
  createHostServer({
    config: parseHostConfig(["--data-root", cwd], {}).config,
    cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
    db,
    secrets: memorySecrets(),
    browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir }, laneWaitMs: serverOptions.laneWaitMs },
    now: () => clock,
  });

async function startServer(script: object = {}, laneWaitMs?: number) {
  serverOptions = { script, laneWaitMs };
  writeFileSync(join(fakeDir, "script.json"), JSON.stringify(script));
  db = migrate(new Database(":memory:"));
  clock = Date.now();
  server = await makeServer();
  device = pairDevice(server);
}

/** Stops the host and starts it again on the same data root and database, as a restart or a deploy does. */
async function restartServer() {
  await server.close();
  server = await makeServer();
}

const until = async (check: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
  expect(check()).toBe(true);
};

const ui = (path: string, body: object) => clientPost(server, device, path, body);
const messages = () =>
  existsSync(join(claudeDir, "messages.jsonl"))
    ? readFileSync(join(claudeDir, "messages.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { text: string }).text)
    : [];

/** A browser-enabled bot; `openChat` makes its routine turns chat-hosted, otherwise they run headless. */
async function setup(openChat: boolean) {
  const botId = createBot(cwd, "bot").id;
  expect((await ui("/api/bots/browser", { botId, enabled: true })).status).toBe(200);
  if (openChat) expect((await ui("/api/open", { botId })).status).toBe(200);
  const connect = async () => {
    const s = defined(server.browser.lease(botId).servers[0], "server");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
      }),
    );
    closers.push(() => client.close());
    return (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }).then((r) => ({
        isError: r.isError === true,
        text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
      }));
  };
  return { botId, call: await connect(), connect };
}

async function startRoutine(botId: string) {
  const created = await ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "check",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routine = (await created.json()) as { id: string };
  await ui("/api/routines/run", { id: routine.id });
  return routine.id;
}

const runs = async (id: string) =>
  (await (await ui("/api/routines/runs", { id })).json()) as {
    output: string | null;
    error: string | null;
    status: string;
  }[];

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine turn", (_label, openChat) => {
  test("browsing works; browser_login is still refused with the unattended message", async () => {
    await startServer();
    const { botId, call } = await setup(openChat);
    writeFileSync(join(claudeDir, "hold"), "");
    await startRoutine(botId);
    await until(() => messages().length === 1);

    expect((await call("browser_open", { url: "https://example.com" })).isError).toBe(false);
    expect((await call("browser_snapshot")).isError).toBe(false);
    expect(await call("browser_login", { entry: "Example" })).toEqual({
      isError: true,
      text: UNATTENDED,
    });
  });

  test("the tools work again once the routine is over", async () => {
    await startServer();
    const { botId, call } = await setup(openChat);
    const id = await startRoutine(botId);
    await until(() => messages().length === 1);
    let done = false;
    for (let i = 0; i < 160 && !done; i++) {
      done = (await runs(id))[0]?.status === "succeeded";
      if (!done) await Bun.sleep(25);
    }
    expect(done).toBe(true);
    const r = await call("browser_request_takeover", { reason: "CAPTCHA" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).status).toBe("waiting_for_user");
  });
});

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine takeover", (_label, openChat) => {
  /** A routine turn that requested a takeover and ended: the run is parked and its bot's browser is held. */
  async function park(reason = "solve the CAPTCHA") {
    await startServer();
    const bot = await setup(openChat);
    writeFileSync(join(claudeDir, "hold"), "");
    const routineId = await startRoutine(bot.botId);
    await until(() => messages().length === 1);
    expect((await bot.call("browser_open", { url: "https://example.com" })).isError).toBe(false);

    const requested = await bot.call("browser_request_takeover", { reason });
    expect(requested.isError).toBe(false);
    const wait = JSON.parse(requested.text) as { status: string; id: string; instruction: string };
    expect(wait.status).toBe("waiting_for_user");
    expect(wait.instruction).toContain("End your turn");

    rmSync(join(claudeDir, "hold"));
    await untilRun(routineId, "waiting");
    return { ...bot, routineId, wait };
  }
  const untilRun = async (routineId: string, status: string) => {
    for (let i = 0; i < 160 && (await runs(routineId))[0]?.status !== status; i++)
      await Bun.sleep(25);
    expect((await runs(routineId))[0]?.status).toBe(status);
  };

  test("parks the run and holds the browser; a hand-back resumes the same session and the run succeeds", async () => {
    const { botId, call, connect, routineId } = await park();
    expect(messages()).toHaveLength(1);
    expect((await runs(routineId))[0]?.output).toBeNull();

    // Another caller of the bot's browser meanwhile is refused.
    const second = await connect();
    expect(await second("browser_snapshot")).toEqual({ isError: true, text: "user has control" });

    expect((await ui("/api/browser/control", { botId, action: "hand_back" })).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toContain("finished the takeover");
    expect(messages()[1]).toContain("fresh snapshot");
    expect(messages()[1]).not.toContain("<scheduled-routine");
    expect(await runs(routineId)).toHaveLength(1);
    expect((await call("browser_snapshot")).isError).toBe(false);
  });

  test("Skip resumes the run and tells the bot the user did not handle it", async () => {
    const { call, routineId, wait } = await park("enter the 2FA code");
    expect((await ui("/api/waits/answer", { id: wait.id, action: "skip" })).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toContain("skipped");
    expect(messages()[1]).toContain("enter the 2FA code");
    expect((await call("browser_snapshot")).isError).toBe(false);
  });

  test("a takeover nobody handles for 24 hours fails the run with 'approval expired' and releases the browser", async () => {
    const { call, routineId, wait } = await park();
    clock += DAY + 1000;
    expect((await ui("/api/waits/answer", { id: wait.id, action: "done" })).status).toBe(404);
    await untilRun(routineId, "failed");
    expect((await runs(routineId))[0]).toMatchObject({ error: "approval expired" });
    await until(() => messages().length === 2);
    expect(messages()[1]).toContain("nothing was approved");
    expect((await call("browser_snapshot")).isError).toBe(false);
  });

  test("a restart cancels the takeover and resumes the run with a message that the browser session is gone", async () => {
    const { botId, routineId } = await park();
    await restartServer();
    await untilRun(routineId, "succeeded");
    await until(() => messages().length === 2);
    expect(messages()[1]).toContain("browser session is gone");
    expect(messages()[1]).toContain("request the takeover again");

    // The bot may ask again: its browser works and a new request is an ordinary wait.
    const s = defined(server.browser.lease(botId).servers[0], "server");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
      }),
    );
    closers.push(() => client.close());
    const again = await client.callTool({
      name: "browser_request_takeover",
      arguments: { reason: "again" },
    });
    expect(again.isError).not.toBe(true);
  });
});

describe("login wall in a routine", () => {
  test("the routine's run result carries the bot's report", async () => {
    await startServer({
      pages: {
        "https://example.com/": { title: "Sign in", snapshot: '- textbox "user" [ref=e1]' },
      },
    });
    const { botId } = await setup(false);
    writeFileSync(
      join(claudeDir, "result.txt"),
      "Login wall at example.com; could not check the dashboard.",
    );
    const id = await startRoutine(botId);
    await until(() => messages().length === 1);
    let list = await runs(id);
    for (let i = 0; i < 160 && list[0]?.status === "running"; i++) {
      await Bun.sleep(25);
      list = await runs(id);
    }
    expect(list[0]).toMatchObject({
      status: "succeeded",
      output: "Login wall at example.com; could not check the dashboard.",
    });
  });
});

describe("routine and chat never drive the browser at once", () => {
  test("a chat call during a headless routine's browser call waits for it", async () => {
    await startServer({ delayMs: { snapshot: 500 } }, 5000);
    const { botId, call, connect } = await setup(false);
    writeFileSync(join(claudeDir, "hold"), "");
    await startRoutine(botId);
    await until(() => messages().length === 1);
    const chatCall = await connect();
    expect((await call("browser_open", { url: "https://example.com" })).isError).toBe(false);

    const started = Date.now();
    const routineSide = call("browser_snapshot");
    await Bun.sleep(100);
    const chatSide = chatCall("browser_snapshot");
    const [a, b] = await Promise.all([routineSide, chatSide]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  test("a chat call that cannot get the lane in time fails cleanly", async () => {
    await startServer({ delayMs: { snapshot: 800 } }, 100);
    const { botId, call, connect } = await setup(false);
    writeFileSync(join(claudeDir, "hold"), "");
    await startRoutine(botId);
    await until(() => messages().length === 1);
    const chatCall = await connect();
    expect((await call("browser_open", { url: "https://example.com" })).isError).toBe(false);

    const routineSide = call("browser_snapshot");
    await Bun.sleep(100);
    expect(await chatCall("browser_snapshot")).toEqual({
      isError: true,
      text: "previous browser call still running",
    });
    expect((await routineSide).isError).toBe(false);
  });
});

describe("messages sent while a headless routine runs", () => {
  /** A headless routine holding its bot, with the chat opened on top of it; `messages()[0]` is the routine's prompt. */
  async function headlessHold() {
    await startServer();
    const { botId } = await setup(false);
    writeFileSync(join(claudeDir, "hold"), "");
    await startRoutine(botId);
    await until(() => messages().length === 1);
    expect((await ui("/api/open", { botId })).status).toBe(200);
  }

  test("wait for the routine to end, then reach the bot as the next turn", async () => {
    await headlessHold();
    const sent = (await (await ui("/api/send", { text: "later" })).json()) as { queued?: string };
    expect(sent.queued).toBeString();
    expect(messages()).toHaveLength(1);

    rmSync(join(claudeDir, "hold"), { force: true });
    await until(() => messages().length === 2);
    expect(messages()[1]).toBe("later");
  });

  test("are not delivered once cancelled", async () => {
    await headlessHold();
    const { queued } = (await (await ui("/api/send", { text: "oops" })).json()) as {
      queued: string;
    };
    await ui("/api/send", { text: "keep" });
    expect((await ui("/api/send/cancel", { id: queued })).status).toBe(200);

    rmSync(join(claudeDir, "hold"), { force: true });
    await until(() => messages().length === 2);
    expect(messages()[1]).toBe("keep");
  });
});
