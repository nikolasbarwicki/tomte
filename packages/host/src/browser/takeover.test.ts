import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
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
import type { LiveMessage, ServerEvent } from "@tomte/contract/events";

import { createBot } from "../bots/index.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import { parseHostConfig } from "../platform/config.ts";
import { migrate } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { defined } from "../testing/defined.ts";
import { asDevice, pairDevice } from "../testing/paired-device.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "testing", "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "..", "testing", "fake-claude.ts");
const ENV_KEYS = [
  "AGENT_BROWSER_PATH",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "FAKE_CLAUDE_DIR",
] as const;

let root: string;
let cwd: string;
let fakeDir: string;
let claudeDir: string;
let server: HostServer;
let device: string;
let engineStream: ReturnType<typeof Bun.serve> | undefined;
const sockets = new Set<{ send(s: string): void }>();
const engineInput: string[] = [];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const closers: (() => unknown)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "takeover-test-")));
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

async function startServer(takeoverInactivityMs?: number) {
  engineInput.length = 0;
  engineStream = Bun.serve({
    port: 0,
    fetch: (req, s) =>
      s.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message: (_ws, m) => void engineInput.push(String(m)),
    },
  });
  writeFileSync(join(fakeDir, "script.json"), JSON.stringify({ streamPort: engineStream.port }));
  server = await createHostServer({
    config: parseHostConfig(["--data-root", cwd], {}).config,
    cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
    db: migrate(new Database(":memory:")),
    secrets: memorySecrets(),
    browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
    liveView: { retryMs: 50 },
    ...(takeoverInactivityMs !== undefined && { takeoverInactivityMs }),
  });
  device = pairDevice(server);
}

beforeEach(async () => {
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
  await engineStream?.stop(true);
  sockets.clear();
});

const until = async (check: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
  expect(check()).toBe(true);
};

const ui = (
  path: string,
  body: object,
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: server.clientUrl,
  },
) =>
  fetch(`${server.clientUrl}${path}`, {
    method: "POST",
    headers: { ...asDevice(device), ...headers },
    body: JSON.stringify(body),
  });

/** Everything the chat page receives on /api/events, as it arrives. */
function events() {
  const received: ServerEvent[] = [];
  const abort = new AbortController();
  closers.push(() => abort.abort());
  void (async () => {
    const res = await fetch(`${server.clientUrl}/api/events`, {
      headers: asDevice(device),
      signal: abort.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const parts = (buffer + value).split("\n\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) received.push(JSON.parse(p.replace(/^data: /, "")));
    }
  })();
  return received;
}

/** The control state the Browser panel sees, from its per-bot stream. */
function watchHolder(botId: string) {
  const seen: string[] = [];
  const abort = new AbortController();
  closers.push(() => abort.abort());
  void (async () => {
    const res = await fetch(`${server.clientUrl}/api/browser/live`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.clientUrl,
        ...asDevice(device),
      },
      body: JSON.stringify({ botId }),
      signal: abort.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const parts = (buffer + value).split("\n\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) {
        const m = JSON.parse(p.replace(/^data: /, "")) as LiveMessage;
        if (m.type === "control") seen.push(m.holder);
      }
    }
  })();
  return seen;
}

async function setup() {
  const botId = createBot(cwd, "bot").id;
  expect((await ui("/api/bots/browser", { botId, enabled: true })).status).toBe(200);
  expect((await ui("/api/open", { botId })).status).toBe(200);
  const s = defined(server.browser.lease(botId).servers[0], "server");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.url), {
      requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
    }),
  );
  closers.push(() => client.close());
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }).then((r) => ({
      isError: r.isError === true,
      text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
    }));
  const holder = watchHolder(botId);
  await call("browser_open", { url: "https://example.com" });
  await until(() => sockets.size === 1);
  return { botId, call, holder };
}

const messages = () =>
  existsSync(join(claudeDir, "messages.jsonl"))
    ? readFileSync(join(claudeDir, "messages.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { text: string }).text)
    : [];
const waitCard = (received: ServerEvent[]) =>
  received.find((e) => e.type === "wait") as Extract<ServerEvent, { type: "wait" }> | undefined;
const request = async (
  call: Awaited<ReturnType<typeof setup>>["call"],
  reason = "solve the CAPTCHA",
) =>
  JSON.parse((await call("browser_request_takeover", { reason })).text) as {
    status: string;
    id: string;
  };

describe("human wait: takeover request", () => {
  test("returns waiting_for_user at once, and the card shows in the feed and replays after a reconnect", async () => {
    await startServer();
    const { call } = await setup();
    const before = events();
    const started = Date.now();
    const wait = await request(call);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(wait.status).toBe("waiting_for_user");

    await until(() => !!waitCard(before));
    expect(waitCard(before)).toMatchObject({
      id: wait.id,
      kind: "takeover",
      detail: "solve the CAPTCHA",
      actions: [{ label: "I'm done" }, { label: "Skip" }],
    });

    const reconnected = events();
    await until(() => !!waitCard(reconnected));
    expect(waitCard(reconnected)?.id).toBe(wait.id);
  });

  test("\"I'm done\" closes the card and tells the bot to take a fresh snapshot; the bot's session reopens", async () => {
    await startServer();
    const { call } = await setup();
    const received = events();
    const wait = await request(call);
    await until(() => !!waitCard(received));
    expect(messages()).toEqual([]);

    expect((await ui("/api/waits/answer", { id: wait.id, action: "done" })).status).toBe(200);
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("finished the takeover");
    expect(messages()[0]).toContain("fresh snapshot");
    expect(received).toContainEqual({ type: "wait_resolved", id: wait.id, label: "I'm done" });
    // The same answer twice finds nothing.
    expect((await ui("/api/waits/answer", { id: wait.id, action: "done" })).status).toBe(404);
  });

  test('"Skip" tells the bot the user did not handle it', async () => {
    await startServer();
    const { call } = await setup();
    const wait = await request(call, "enter the 2FA code");
    await ui("/api/waits/answer", { id: wait.id, action: "skip" });
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("skipped");
    expect(messages()[0]).toContain("enter the 2FA code");
  });

  test("the resume message waits for the bot's current turn to end", async () => {
    await startServer();
    const { call } = await setup();
    writeFileSync(join(claudeDir, "hold"), "");
    await ui("/api/send", { text: "hello" });
    await until(() => messages().length === 1);

    const wait = await request(call);
    await ui("/api/waits/answer", { id: wait.id, action: "done" });
    await Bun.sleep(300);
    expect(messages()).toEqual(["hello"]);

    rmSync(join(claudeDir, "hold"));
    await until(() => messages().length === 2);
    expect(messages()[1]).toContain("finished the takeover");
  });

  test("rejects an action the card does not have, and a cross-origin answer", async () => {
    await startServer();
    const { call } = await setup();
    const wait = await request(call);
    expect((await ui("/api/waits/answer", { id: wait.id, action: "allow" })).status).toBe(404);
    expect(
      (
        await ui(
          "/api/waits/answer",
          { id: wait.id, action: "done" },
          { "content-type": "application/json", origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ui(
          "/api/waits/answer",
          { id: wait.id, action: "done" },
          { "content-type": "text/plain", origin: server.clientUrl },
        )
      ).status,
    ).toBe(415);
    await Bun.sleep(100);
    expect(messages()).toEqual([]);
  });

  test("a new session cancels the pending wait and tells the bot", async () => {
    await startServer();
    const { botId, call } = await setup();
    const received = events();
    const wait = await request(call);
    await until(() => !!waitCard(received));

    expect((await ui("/api/session/new", {})).status).toBe(200);
    await until(() => received.some((e) => e.type === "wait_resolved"));
    expect(received).toContainEqual({ type: "wait_resolved", id: wait.id, label: "Cancelled" });
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("cancelled");
    expect(messages()[0]).toContain("new session");
    expect((await call("browser_snapshot")).isError).toBe(false);
    expect(botId).toBeTruthy();
  });

  // The inactivity timer is a real timer in the host; the host-wide fake clock does not drive it, so these tests wait in real time.
  describe.each([
    ["chat-hosted", true],
    ["headless", false],
  ])("a %s routine's takeover request", (_label, chatHosted) => {
    const runStatus = async (routineId: string) =>
      (
        (await (await ui("/api/routines/runs", { id: routineId })).json()) as {
          status: string;
        }[]
      )[0]?.status;
    const untilRun = async (routineId: string, status: string) => {
      for (let i = 0; i < 160 && (await runStatus(routineId)) !== status; i++) await Bun.sleep(25);
      expect(await runStatus(routineId)).toBe(status);
    };

    test("stays open until the first input; then the inactivity limit applies and a timeout counts as Skip", async () => {
      await startServer(300);
      const { botId, call, holder } = await setup();
      // A routine turn is chat-hosted while its bot's chat is open, and headless once another bot's chat is.
      if (!chatHosted) {
        const other = createBot(cwd, "other").id;
        expect((await ui("/api/open", { botId: other })).status).toBe(200);
      }
      writeFileSync(join(claudeDir, "hold"), "");
      const created = await ui("/api/routines/create", {
        botId,
        name: "nightly",
        instruction: "check",
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
      });
      const routine = (await created.json()) as { id: string };
      await ui("/api/routines/run", { id: routine.id });
      await until(() => messages().length === 1);

      expect((await request(call, "enter the code")).status).toBe("waiting_for_user");
      rmSync(join(claudeDir, "hold"));
      await untilRun(routine.id, "waiting");

      // Three times the inactivity limit with no input: the user still holds the browser and the run still waits.
      await Bun.sleep(900);
      expect(holder.at(-1)).toBe("user");
      expect(await runStatus(routine.id)).toBe("waiting");
      expect(messages()).toHaveLength(1);

      // The first input starts the limit; with no more input it ends as Skip and the run goes on.
      const moved = { botId, kind: "mouse", eventType: "mouseMoved", x: 1, y: 1 };
      expect((await ui("/api/browser/input", moved)).status).toBe(200);
      await until(() => messages().length === 2);
      expect(messages()[1]).toContain("counts as skipped");
      expect(messages()[1]).toContain("enter the code");
      await untilRun(routine.id, "succeeded");
      await until(() => holder.at(-1) === "bot");
    });
  });
});

describe("user takeover", () => {
  test("bot calls are refused while the user holds control, and the bot is told when it returns", async () => {
    await startServer();
    const { botId, call, holder } = await setup();
    expect((await ui("/api/browser/control", { botId, action: "take" })).status).toBe(200);
    await until(() => holder.at(-1) === "user");

    const refused = await call("browser_snapshot");
    expect(refused).toEqual({ isError: true, text: "user has control" });
    expect((await call("browser_click", { ref: "r1.e1" })).text).toBe("user has control");

    await ui("/api/browser/control", { botId, action: "hand_back" });
    await until(() => holder.at(-1) === "bot");
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("handed the browser back");
    expect(messages()[0]).toContain("fresh snapshot");
    expect((await call("browser_snapshot")).isError).toBe(false);
  });

  test("a takeover during which the bot was not refused sends no message", async () => {
    await startServer();
    const { botId } = await setup();
    await ui("/api/browser/control", { botId, action: "take" });
    await ui("/api/browser/control", { botId, action: "hand_back" });
    await Bun.sleep(300);
    expect(messages()).toEqual([]);
  });

  test("taking control stops new calls, waits for the running one, then grants", async () => {
    await startServer();
    const { botId, call, holder } = await setup();
    writeFileSync(
      join(fakeDir, "script.json"),
      JSON.stringify({ streamPort: engineStream!.port, delayMs: { snapshot: 700 } }),
    );
    await until(() => holder.length > 0);

    const running = call("browser_snapshot");
    await Bun.sleep(150);
    const taking = ui("/api/browser/control", { botId, action: "take" });
    await until(() => holder.at(-1) === "draining");
    // Not granted yet: input is refused, and a new call is refused outright.
    expect(
      (
        await ui("/api/browser/input", {
          botId,
          kind: "mouse",
          eventType: "mouseMoved",
          x: 1,
          y: 1,
        })
      ).status,
    ).toBe(409);
    expect((await call("browser_get_text")).text).toBe("user has control");

    expect((await running).isError).toBe(false);
    expect((await taking).status).toBe(200);
    await until(() => holder.at(-1) === "user");
    expect(
      (
        await ui("/api/browser/input", {
          botId,
          kind: "mouse",
          eventType: "mouseMoved",
          x: 1,
          y: 1,
        })
      ).status,
    ).toBe(200);
  });

  test("taking control of a browser that is not running is refused", async () => {
    await startServer();
    const botId = createBot(cwd, "idle").id;
    await ui("/api/bots/browser", { botId, enabled: true });
    expect((await ui("/api/browser/control", { botId, action: "take" })).status).toBe(409);
  });

  test("control ends after the inactivity period and counts as Skip for a requested takeover", async () => {
    await startServer(250);
    const { call, holder } = await setup();
    const received = events();
    const wait = await request(call, "enter the code");
    await until(() => holder.at(-1) === "user");

    await until(() => holder.at(-1) === "bot");
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("skipped");
    expect(messages()[0]).toContain("enter the code");
    expect(received).toContainEqual({ type: "wait_resolved", id: wait.id, label: "Timed out" });
    expect((await call("browser_snapshot")).isError).toBe(false);
  });

  test("input keeps control alive past the inactivity period", async () => {
    await startServer(400);
    const { botId, holder } = await setup();
    await ui("/api/browser/control", { botId, action: "take" });
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(150);
      expect(
        (
          await ui("/api/browser/input", {
            botId,
            kind: "mouse",
            eventType: "mouseMoved",
            x: i,
            y: i,
          })
        ).status,
      ).toBe(200);
    }
    expect(holder.at(-1)).toBe("user");
    await until(() => holder.at(-1) === "bot");
  });
});

describe("takeover input", () => {
  test("is refused unless the user holds control, and nothing reaches the engine", async () => {
    await startServer();
    const { botId } = await setup();
    const res = await ui("/api/browser/input", {
      botId,
      kind: "mouse",
      eventType: "mousePressed",
      x: 5,
      y: 5,
      button: "left",
      clickCount: 1,
    });
    expect(res.status).toBe(409);
    await Bun.sleep(100);
    expect(engineInput).toEqual([]);
  });

  test("a bot-requested takeover gives the user control straight away", async () => {
    await startServer();
    const { botId, call } = await setup();
    await request(call);
    expect(
      (
        await ui("/api/browser/input", {
          botId,
          kind: "mouse",
          eventType: "mouseMoved",
          x: 5,
          y: 5,
        })
      ).status,
    ).toBe(200);
    await until(() => engineInput.length === 1);
  });

  test("mouse, keyboard and touch reach the engine in order, with only known fields", async () => {
    await startServer();
    const { botId } = await setup();
    await ui("/api/browser/control", { botId, action: "take" });
    const send = (e: object) =>
      ui("/api/browser/input", {
        botId,
        ...e,
        extra: "ignored",
        injected: { type: "command", action: "evaluate" },
      });
    expect(
      (
        await send({
          kind: "mouse",
          eventType: "mousePressed",
          x: 10,
          y: 20,
          button: "left",
          clickCount: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send({
          kind: "keyboard",
          eventType: "keyDown",
          key: "a",
          code: "KeyA",
          text: "a",
          windowsVirtualKeyCode: 65,
        })
      ).status,
    ).toBe(200);
    expect(
      (await send({ kind: "touch", eventType: "touchStart", touchPoints: [{ x: 1, y: 2 }] }))
        .status,
    ).toBe(200);
    await until(() => engineInput.length === 3);
    expect(engineInput.map((m) => JSON.parse(m))).toEqual([
      {
        type: "input_mouse",
        eventType: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
      },
      {
        type: "input_keyboard",
        eventType: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
        windowsVirtualKeyCode: 65,
      },
      { type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 1, y: 2 }] },
    ]);
  });

  test("malformed events are refused", async () => {
    await startServer();
    const { botId } = await setup();
    await ui("/api/browser/control", { botId, action: "take" });
    for (const bad of [
      { kind: "mouse", eventType: "evaluate", x: 1, y: 1 },
      { kind: "mouse", eventType: "mouseMoved", x: "1", y: 1 },
      { kind: "drag" },
      {},
    ]) {
      expect((await ui("/api/browser/input", { botId, ...bad })).status).toBe(400);
    }
    expect(engineInput).toEqual([]);
  });

  test("uses the live view's Origin and content-type checks", async () => {
    await startServer();
    const { botId } = await setup();
    await ui("/api/browser/control", { botId, action: "take" });
    const event = { botId, kind: "mouse", eventType: "mouseMoved", x: 1, y: 1 };
    expect(
      (await ui("/api/browser/input", event, { "content-type": "application/json" })).status,
    ).toBe(403);
    expect(
      (
        await ui("/api/browser/input", event, {
          "content-type": "application/json",
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await ui("/api/browser/input", event, {
          "content-type": "text/plain",
          origin: server.clientUrl,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await ui(
          "/api/browser/control",
          { botId, action: "hand_back" },
          { "content-type": "application/json", origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.clientUrl}/api/browser/input`, {
          headers: { origin: server.clientUrl, ...asDevice(device) },
        })
      ).status,
    ).toBe(405);
    expect(engineInput).toEqual([]);
  });

  test("a bot with the browser switched off cannot be controlled", async () => {
    await startServer();
    const botId = createBot(cwd, "off").id;
    expect((await ui("/api/browser/control", { botId, action: "take" })).status).toBe(403);
    expect(
      (
        await ui("/api/browser/input", {
          botId,
          kind: "mouse",
          eventType: "mouseMoved",
          x: 1,
          y: 1,
        })
      ).status,
    ).toBe(403);
  });

  test("events are never logged, put in the chat feed, or recorded", async () => {
    await startServer();
    const { botId } = await setup();
    const logged = spyOn(console, "error");
    const log = spyOn(console, "log");
    await ui("/api/browser/control", { botId, action: "take" });
    const typed = "hunter2-typed-secret";
    for (const ch of typed)
      await ui("/api/browser/input", {
        botId,
        kind: "keyboard",
        eventType: "keyDown",
        key: ch,
        text: ch,
      });
    await ui("/api/browser/input", {
      botId,
      kind: "mouse",
      eventType: "mousePressed",
      x: 777,
      y: 888,
      button: "left",
      clickCount: 1,
    });
    await ui("/api/browser/input", { botId, kind: "mouse", eventType: "bogus", x: 777, y: 888 });
    await until(() => engineInput.length === typed.length + 1);

    const received = events();
    await Bun.sleep(300);
    const everything =
      JSON.stringify(received) + JSON.stringify(logged.mock.calls) + JSON.stringify(log.mock.calls);
    logged.mockRestore();
    log.mockRestore();
    expect(everything).not.toContain("hunter2");
    // A whole token: a bare "777" substring collides with the random UUIDs and timestamps in the feed.
    expect(everything).not.toMatch(/\b777\b/);
    expect(received.some((e) => e.type === "user" || e.type === "wait")).toBe(false);
    expect(messages()).toEqual([]);
  });
});
