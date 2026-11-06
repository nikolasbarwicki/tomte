import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
import type { SandboxStatus } from "./sandbox.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "testing", "fake-agent-browser.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH"] as const;

let root: string;
let cwd: string;
let fakeDir: string;
let server: HostServer;
let secrets: ReturnType<typeof memorySecrets>;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clients: Client[] = [];
const NO_SANDBOX: SandboxStatus = {
  status: "unavailable",
  reason: "the shell sandbox is not supported on win32",
};
let sandbox: SandboxStatus;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browser-test-")));
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

beforeEach(async () => {
  cwd = join(root, `ws-${Math.random().toString(36).slice(2)}`);
  fakeDir = join(cwd, "fake");
  mkdirSync(fakeDir, { recursive: true });
  secrets = memorySecrets();
  sandbox = { status: "available" };
  server = await createHostServer({
    config: parseHostConfig(["--data-root", cwd], {}).config,
    cli: { path: "/nonexistent/claude", source: "CLAUDE_PATH", needsShell: false },
    db: migrate(new Database(":memory:")),
    secrets,
    browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
    sandbox: () => sandbox,
  });
});

const closeAll = async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
};

const script = (s: object) => writeFileSync(join(fakeDir, "script.json"), JSON.stringify(s));
const calls = (): { argv: string[]; env: Record<string, string> }[] => {
  try {
    return readFileSync(join(fakeDir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const api = (path: string, body: object) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const enable = async (botId: string, enabled = true) =>
  expect((await api("/api/bots/browser", { botId, enabled })).status).toBe(200);
const newBot = (name = "bot") => createBot(cwd, name).id;

/** What a harness does: lease the endpoint for a bot session, then connect an MCP client with its token. */
async function connect(botId: string) {
  const lease = server.browser.lease(botId);
  const s = defined(lease.servers[0], "server");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.url), {
      requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
    }),
  );
  clients.push(client);
  return { client, lease, token: s.token, url: s.url };
}

const post = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

const text = (r: unknown) =>
  defined((r as { content: { text: string }[] }).content[0], "content").text;

describe("switch", () => {
  test("a bot with the switch off gets no browser server", async () => {
    const id = newBot();
    expect(server.browser.lease(id).servers).toEqual([]);
    await closeAll();
  });

  test("turning the switch off refuses a token already issued and removes the server for new sessions", async () => {
    const id = newBot();
    await enable(id);
    const { token, url } = await connect(id);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(200);

    await enable(id, false);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect(server.browser.lease(id).servers).toEqual([]);
    await closeAll();
  });

  test("the switch is stored in the bot's settings and refuses an unknown bot", async () => {
    const id = newBot();
    await enable(id);
    expect(JSON.parse(readFileSync(join(cwd, "bots", id, "bot.json"), "utf8")).browser).toEqual({
      enabled: true,
      headed: false,
    });
    expect(
      (
        await api("/api/bots/browser", {
          botId: "00000000-0000-4000-8000-000000000000",
          enabled: true,
        })
      ).status,
    ).toBe(404);
    await closeAll();
  });
});

describe("endpoint hardening", () => {
  test("rejects a missing, wrong, revoked or other-origin request", async () => {
    const id = newBot();
    await enable(id);
    const { token, url, lease } = await connect(id);

    expect((await post(url, {})).status).toBe(401);
    expect((await post(url, { authorization: "Bearer nope" })).status).toBe(401);
    expect(
      (await post(url, { authorization: `Bearer ${token}`, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(200);

    lease.release();
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(401);
    await closeAll();
  });

  test("rejects a Host header that is not loopback on this port", async () => {
    const id = newBot();
    await enable(id);
    const { token, url } = await connect(id);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            host: "rebind.example",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
    await closeAll();
  });

  test("a token acts only as its own bot", async () => {
    const a = newBot("a");
    const b = newBot("b");
    await enable(a);
    await enable(b);
    const ta = await connect(a);
    await connect(b);
    await ta.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
    const sessions = new Set(calls().map((c) => c.argv[c.argv.indexOf("--session") + 1]));
    expect([...sessions]).toEqual([`claudebot-${a}`]);
    await closeAll();
  });

  test("revoking a bot revokes every token it holds", async () => {
    const id = newBot();
    await enable(id);
    const { token, url } = await connect(id);
    server.browser.revokeBot(id);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(401);
    await closeAll();
  });
});

describe("sandbox unavailable", () => {
  test("the endpoint refuses a browser-enabled bot", async () => {
    const id = newBot();
    await enable(id);
    const { token, url } = await connect(id);

    sandbox = NO_SANDBOX;
    expect(server.browser.lease(id).servers).toEqual([]);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect(JSON.parse(readFileSync(join(cwd, "bots", id, "bot.json"), "utf8")).browser).toEqual({
      enabled: true,
      headed: false,
    });
    await closeAll();
  });

  test("the UI is told the browser is unavailable, with the reason, and the switch refuses to turn on", async () => {
    sandbox = NO_SANDBOX;
    const id = newBot();
    expect(await (await fetch(`${server.url}/api/info`)).json()).toHaveProperty(
      "browser",
      NO_SANDBOX,
    );
    const res = await api("/api/bots/browser", { botId: id, enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_SANDBOX.reason });
    await closeAll();
  });
});

describe("tools", () => {
  test("an enabled bot sees the browser tools", async () => {
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toContain(
      "browser_snapshot",
    );
    await closeAll();
  });

  test("open returns the page snapshot, with host-chosen engine flags and the key only in the environment", async () => {
    script({
      pages: {
        "https://example.com/": {
          title: "Example Domain",
          snapshot: '- heading "Example Domain" [ref=e1]\n- link "Learn more" [ref=e2]',
        },
      },
    });
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);

    const r = await client.callTool({
      name: "browser_open",
      arguments: { url: "https://example.com" },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Example Domain");
    expect(text(r)).toContain('link "Learn more" [ref=r1.e2]');

    const [first, second] = calls();
    const open = defined(first, "open call");
    const snapshot = defined(second, "snapshot call");
    const session = `claudebot-${id}`;
    for (const c of [open, snapshot]) {
      expect(c.argv).toContain("--json");
      expect(c.argv.slice(c.argv.indexOf("--session"), c.argv.indexOf("--session") + 2)).toEqual([
        "--session",
        session,
      ]);
      expect(c.argv.slice(c.argv.indexOf("--restore"), c.argv.indexOf("--restore") + 2)).toEqual([
        "--restore",
        session,
      ]);
      expect(c.argv).toContain("--executable-path");
    }
    const key = secrets.entries.get("browser-encryption-key")!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(open.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(key);
    expect(
      calls()
        .flatMap((c) => c.argv)
        .join(" "),
    ).not.toContain(key);
    await closeAll();
  });

  test("snapshot honors interactive_only and selector, and reports a missing selector", async () => {
    script({
      pages: {
        "https://example.com/": {
          snapshot: '- text "intro"\n- link "Go" [ref=e1]',
          selectors: { main: '- text "scoped"' },
        },
      },
    });
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);
    await client.callTool({ name: "browser_open", arguments: { url: "https://example.com/" } });

    const interactive = await client.callTool({
      name: "browser_snapshot",
      arguments: { interactive_only: true },
    });
    expect(text(interactive)).toContain('link "Go"');
    expect(text(interactive)).not.toContain("intro");
    expect(
      text(await client.callTool({ name: "browser_snapshot", arguments: { selector: "main" } })),
    ).toContain("scoped");

    const missing = await client.callTool({
      name: "browser_snapshot",
      arguments: { selector: "#nope" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("did not match");
    await closeAll();
  });

  test("a bot cannot smuggle flags or non-web URLs into the engine", async () => {
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "--help", "about:blank"]) {
      expect((await client.callTool({ name: "browser_open", arguments: { url } })).isError).toBe(
        true,
      );
    }
    expect(
      (await client.callTool({ name: "browser_snapshot", arguments: { selector: "--eval" } }))
        .isError,
    ).toBe(true);
    expect(calls()).toEqual([]);
    await closeAll();
  });

  test("an engine failure reaches the bot as a tool error", async () => {
    script({ fail: { open: "net::ERR_NAME_NOT_RESOLVED" } });
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);
    const r = await client.callTool({
      name: "browser_open",
      arguments: { url: "https://nowhere.invalid" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ERR_NAME_NOT_RESOLVED");
    await closeAll();
  });
});

describe("runtime lifecycle", () => {
  test("the engine is not started until the first tool call", async () => {
    const id = newBot();
    await enable(id);
    const { client } = await connect(id);
    await client.listTools();
    expect(calls()).toEqual([]);
    await closeAll();
    expect(calls()).toEqual([]);
  });

  test("shutdown closes every browser that was started, and only those", async () => {
    const [a, b, idle] = [newBot("a"), newBot("b"), newBot("idle")];
    for (const id of [a, b, idle]) await enable(id);
    const ca = await connect(a);
    const cb = await connect(b);
    await connect(idle);
    await ca.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
    await cb.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
    const before = calls().length;

    await closeAll();
    const closes = calls()
      .slice(before)
      .filter((c) => c.argv.includes("close"));
    expect(
      closes.map((c) => defined(c.argv[c.argv.indexOf("--session") + 1], "session")).sort(),
    ).toEqual([`claudebot-${a}`, `claudebot-${b}`].sort());
  });
});

describe("network block", () => {
  test("opening a URL on the host server returns a blocked-navigation result, and every engine call carries the proxy", async () => {
    const id = newBot();
    await enable(id);
    script({ viaProxy: true });
    const { client } = await connect(id);
    const r = await client.callTool({
      name: "browser_open",
      arguments: { url: `${server.url}/api/info` },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("navigation blocked");
    expect(text(r)).toContain("127.0.0.1");
    for (const c of calls()) {
      expect(c.argv).toContain("--proxy");
      expect(c.argv).toContain("--proxy-bypass-list=<-loopback>");
    }
    await closeAll();
  });
});
