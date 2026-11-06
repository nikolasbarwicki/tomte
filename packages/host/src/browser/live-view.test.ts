import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../bots/index.ts";
import { migrate } from "../platform/db.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import { memorySecrets } from "../platform/secrets.ts";
import type { LiveMessage } from "@claudebot/contract/events";
import { parseHostConfig } from "../platform/config.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "testing", "fake-agent-browser.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH"] as const;

let root: string;
let cwd: string;
let fakeDir: string;
let server: HostServer;
let engineStream: ReturnType<typeof Bun.serve> | undefined;
const sockets = new Set<{ send(s: string): void }>();
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const closers: (() => unknown)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "liveview-test-")));
  const chrome = join(root, "chrome");
  writeFileSync(chrome, "");
  process.env.AGENT_BROWSER_PATH = FAKE_ENGINE;
  process.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
});

afterAll(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  cwd = join(root, `ws-${Math.random().toString(36).slice(2)}`);
  fakeDir = join(cwd, "fake");
  mkdirSync(fakeDir, { recursive: true });
  // Stands in for the engine's stream: the host reads its port from `stream status`.
  engineStream = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message() {},
    },
  });
  writeFileSync(join(fakeDir, "script.json"), JSON.stringify({ streamPort: engineStream.port }));
  server = await createHostServer({
    config: parseHostConfig(["--data-root", cwd], {}).config,
    cli: { path: "/nonexistent/claude", source: "CLAUDE_PATH", needsShell: false },
    db: migrate(new Database(":memory:")),
    secrets: memorySecrets(),
    browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
    liveView: { retryMs: 50 },
  });
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await server.close();
  await engineStream?.stop(true);
  sockets.clear();
});

const calls = () => existsSync(join(fakeDir, "calls.jsonl"));
const api = (path: string, body: object) => fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function enabledBot() {
  const id = createBot(cwd, "bot").id;
  expect((await api("/api/bots/browser", { botId: id, enabled: true })).status).toBe(200);
  return id;
}

/** Opens the live view the way the page does: same-origin POST with a JSON body. */
async function watch(botId: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.url}/api/browser/live`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url, ...headers },
    body: JSON.stringify({ botId }),
  });
  const reader = res.body?.getReader();
  closers.push(() => reader?.cancel());
  const decoder = new TextDecoder();
  const queue: LiveMessage[] = [];
  const arrived = new EventTarget();
  void (async () => {
    let buffer = "";
    while (reader) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const parts = (buffer + decoder.decode(value)).split("\n\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) queue.push(JSON.parse(p.replace(/^data: /, "")));
      arrived.dispatchEvent(new Event("message"));
    }
  })();
  /** The next `n` messages, waiting for them to arrive. */
  async function next(n = 1): Promise<LiveMessage[]> {
    while (queue.length < n) await new Promise((r) => arrived.addEventListener("message", r, { once: true }));
    return queue.splice(0, n);
  }
  /** Everything that arrives within `ms`. */
  async function drain(ms: number): Promise<LiveMessage[]> {
    await Bun.sleep(ms);
    return queue.splice(0);
  }
  return { res, next, drain };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(30);
  expect(check()).toBe(true);
};

const frame = (n: number) => JSON.stringify({ type: "frame", data: `jpeg-${n}`, seq: n, metadata: { deviceWidth: 1280, deviceHeight: 720 } });

async function startBrowser(botId: string) {
  const lease = server.browser.lease(botId);
  const [s] = lease.servers;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  closers.push(() => client.close());
  await client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
}

describe("live view", () => {
  test("opening it never starts a browser and shows the stopped placeholder", async () => {
    const id = await enabledBot();
    const view = await watch(id);
    expect(view.res.status).toBe(200);
    expect(view.res.headers.get("content-type")).toBe("text/event-stream");
    expect(await view.next(2)).toEqual([{ type: "control", holder: "bot" }, { type: "state", state: "stopped" }]);
    await Bun.sleep(200);
    expect(calls()).toBe(false);
  });

  test("the stream resumes when the browser starts, and relays frame, url, tabs and status only", async () => {
    const id = await enabledBot();
    const view = await watch(id);
    expect(await view.next(2)).toEqual([{ type: "control", holder: "bot" }, { type: "state", state: "stopped" }]);

    await startBrowser(id);
    await until(() => sockets.size === 1);
    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: "command", action: "fill", params: { value: "hunter2" } }));
      ws.send(JSON.stringify({ type: "tabs", tabs: [{ tabId: "t1", title: "Example", url: "https://example.com/", active: true, targetId: "x" }] }));
      ws.send(JSON.stringify({ type: "url", url: "https://example.com/" }));
      ws.send(JSON.stringify({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 }));
      ws.send(frame(1));
    }
    const got = await view.drain(400);
    expect(got).toContainEqual({ type: "state", state: "live" });
    expect(got).toContainEqual({ type: "tabs", tabs: [{ id: "t1", title: "Example", url: "https://example.com/", active: true }] });
    expect(got).toContainEqual({ type: "url", url: "https://example.com/" });
    expect(got).toContainEqual({ type: "frame", data: "jpeg-1", width: 1280, height: 720 });
    expect(JSON.stringify(got)).not.toContain("hunter2");
  });

  test("a slow viewer gets the newest frame, not a backlog", async () => {
    const id = await enabledBot();
    const view = await watch(id);
    await view.next();
    await startBrowser(id);
    await until(() => sockets.size === 1);
    await view.drain(100);

    for (let n = 0; n < 300; n++) for (const ws of sockets) ws.send(frame(n));
    const got = (await view.drain(500)).filter((m) => m.type === "frame");
    expect(got.length).toBeLessThan(30);
    expect(got.at(-1)).toMatchObject({ data: "jpeg-299" });
  });

  test("frames are capped at the pacing rate", async () => {
    const id = await enabledBot();
    const view = await watch(id);
    await view.next();
    await startBrowser(id);
    await until(() => sockets.size === 1);
    await view.drain(100);

    const start = Date.now();
    const sender = setInterval(() => {
      for (const ws of sockets) ws.send(frame(Date.now()));
    }, 5);
    const got = (await view.drain(1000)).filter((m) => m.type === "frame");
    clearInterval(sender);
    const seconds = (Date.now() - start) / 1000;
    expect(got.length / seconds).toBeLessThanOrEqual(17);
    expect(got.length).toBeGreaterThan(5);
  });

  test("a stopping browser flips the viewer back to the placeholder", async () => {
    const id = await enabledBot();
    const view = await watch(id);
    await view.next();
    await startBrowser(id);
    await until(() => sockets.size === 1);
    expect((await view.drain(200)).at(-1)).toEqual({ type: "state", state: "live" });

    writeFileSync(join(fakeDir, "script.json"), JSON.stringify({}));
    for (const ws of sockets) (ws as unknown as { close(): void }).close();
    await until(() => sockets.size === 0);
    expect((await view.drain(300)).some((m) => m.type === "state" && m.state === "stopped")).toBe(true);
  });

  test("a bot with the switch off has no live view", async () => {
    const id = createBot(cwd, "off").id;
    const res = await fetch(`${server.url}/api/browser/live`, { method: "POST", headers: { "content-type": "application/json", origin: server.url }, body: JSON.stringify({ botId: id }) });
    expect(res.status).toBe(403);
  });
});

describe("live view hardening", () => {
  const raw = (headers: Record<string, string>, body: string, method = "POST") =>
    fetch(`${server.url}/api/browser/live`, { method, headers, body: method === "POST" ? body : undefined });

  test("rejects a missing or cross-origin Origin", async () => {
    const id = await enabledBot();
    const body = JSON.stringify({ botId: id });
    expect((await raw({ "content-type": "application/json" }, body)).status).toBe(403);
    expect((await raw({ "content-type": "application/json", origin: "https://evil.example" }, body)).status).toBe(403);
    expect((await raw({ "content-type": "application/json", origin: "http://127.0.0.1:1" }, body)).status).toBe(403);
    expect((await raw({ "content-type": "application/json", origin: "null" }, body)).status).toBe(403);
  });

  test("rejects a simple-form content type and a non-POST method", async () => {
    const id = await enabledBot();
    const body = JSON.stringify({ botId: id });
    expect((await raw({ "content-type": "text/plain", origin: server.url }, body)).status).toBe(415);
    expect((await raw({ "content-type": "application/x-www-form-urlencoded", origin: server.url }, `botId=${id}`)).status).toBe(415);
    expect((await raw({ origin: server.url }, body)).status).toBe(415);
    expect((await raw({ origin: server.url }, "", "GET")).status).toBe(405);
  });

  test("rejects a bad Host header", async () => {
    const id = await enabledBot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = require("node:http").request(
        `${server.url}/api/browser/live`,
        { method: "POST", headers: { host: "evil.example", origin: "http://evil.example", "content-type": "application/json" } },
        (res: { statusCode: number; resume(): void }) => (res.resume(), resolve(res.statusCode)),
      );
      req.on("error", reject);
      req.end(JSON.stringify({ botId: id }));
    });
    expect(status).toBe(403);
  });

  test("an unknown or missing bot is refused", async () => {
    const headers = { "content-type": "application/json", origin: server.url };
    expect((await raw(headers, "{}")).status).toBe(400);
    expect((await raw(headers, "not json")).status).toBe(400);
    expect((await raw(headers, JSON.stringify({ botId: "nope" }))).status).toBe(403);
  });
});
