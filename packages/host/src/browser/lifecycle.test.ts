import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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

import { createBot, getBot } from "../bots/index.ts";
import { createCredentials } from "../credentials/index.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import { agentOrigin, parseHostConfig } from "../platform/config.ts";
import { migrate } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { defined } from "../testing/defined.ts";
import { clientPost, pairDevice } from "../testing/paired-device.ts";
import { removeBotBrowser } from "./cleanup.ts";
import type { EgressProxy } from "./egress-proxy.ts";
import { createBrowserEndpoint } from "./endpoint.ts";
import { sessionName } from "./engine-cli.ts";
import { createHumanWaits } from "./human-waits.ts";
import { createBrowserLogin } from "./login.ts";
import { isAlive } from "./process.ts";
import { createBrowserRuntimes, type BrowserRuntimeOptions } from "./runtime.ts";
import { Takeover } from "./takeover.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "testing", "fake-agent-browser.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let fakeDir: string;
let home: string;
let sockets: string;
const spawned: number[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-test-")));
  const chrome = join(root, "chrome");
  writeFileSync(chrome, "");
  process.env.AGENT_BROWSER_PATH = FAKE_ENGINE;
  process.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
});

afterAll(() => {
  for (const k of ENV_KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  for (const pid of spawned) if (isAlive(pid)) process.kill(-pid, "SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const dir = join(root, `t-${Math.random().toString(36).slice(2)}`);
  fakeDir = join(dir, "fake");
  home = join(dir, "home");
  sockets = join(dir, "sockets");
  for (const d of [fakeDir, home, sockets]) mkdirSync(d, { recursive: true });
});

const script = (s: object) => writeFileSync(join(fakeDir, "script.json"), JSON.stringify(s));
const seedSessions = (names: string[]) =>
  writeFileSync(
    join(fakeDir, "state.json"),
    JSON.stringify(Object.fromEntries(names.map((n) => [n, "https://x.test"]))),
  );
const calls = (): { argv: string[] }[] => {
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
const closedSessions = () =>
  calls()
    .filter((c) => c.argv.includes("close"))
    .map((c) => c.argv[c.argv.indexOf("--session") + 1]);
/** A killed child lingers as a zombie until the test runner reaps it. */
async function expectDead(pid: number) {
  for (let i = 0; i < 40 && isAlive(pid); i++) await Bun.sleep(25);
  expect(isAlive(pid)).toBe(false);
}
const BOT = "11111111-1111-4111-8111-111111111111";
const statePath = (botId = BOT) =>
  join(home, ".agent-browser", "sessions", `${sessionName(botId)}-${sessionName(botId)}.json.enc`);
const saveState = (botId = BOT) => {
  mkdirSync(join(home, ".agent-browser", "sessions"), { recursive: true });
  writeFileSync(statePath(botId), "saved-logins");
};

const stubEgress = (): EgressProxy =>
  ({
    url: "http://127.0.0.1:9",
    start: async () => {},
    stop: async () => {},
    blockedSince: () => [],
  }) as unknown as EgressProxy;

function runtimes(o: BrowserRuntimeOptions = {}) {
  return createBrowserRuntimes(memorySecrets(), stubEgress(), join(home, "data"), {
    env: { FAKE_AGENT_BROWSER_DIR: fakeDir, HOME: home, AGENT_BROWSER_SOCKET_DIR: sockets },
    ...o,
  });
}

/** A stand-in engine daemon with one child as its "Chrome", each in its own process group like the real thing. */
async function fakeDaemon(botId: string, { ignoreTerm = false } = {}) {
  const trap = ignoreTerm ? "trap '' TERM HUP;" : "";
  const daemon = spawn("sh", ["-c", `${trap} sleep 300 & wait`], {
    detached: true,
    stdio: "ignore",
  });
  daemon.unref();
  spawned.push(daemon.pid!);
  await Bun.sleep(150);
  writeFileSync(join(sockets, `${sessionName(botId)}.pid`), String(daemon.pid));
  return daemon.pid!;
}

describe("lane", () => {
  test("a second call waits for the first, then fails with 'previous browser call still running' once the wait is over", async () => {
    const rt = runtimes({ laneWaitMs: 150 });
    const browser = rt.forBot(BOT);
    const first = browser.exclusive(() => Bun.sleep(400).then(() => "first"));
    await expect(browser.exclusive(async () => "second")).rejects.toThrow(
      "previous browser call still running",
    );
    expect(await first).toBe("first");
    expect(await browser.exclusive(async () => "third")).toBe("third");
  });

  test("calls that fit inside the wait run in order, one at a time", async () => {
    const browser = runtimes({ laneWaitMs: 2000 }).forBot(BOT);
    const log: string[] = [];
    const job = (n: string) =>
      browser.exclusive(
        async () => (log.push(`${n}:start`), await Bun.sleep(40), log.push(`${n}:end`)),
      );
    await Promise.all([job("a"), job("b"), job("c")]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("bots have separate lanes", async () => {
    const rt = runtimes({ laneWaitMs: 50 });
    const slow = rt.forBot(BOT).exclusive(() => Bun.sleep(150));
    expect(
      await rt.forBot("22222222-2222-4222-8222-222222222222").exclusive(async () => "ok"),
    ).toBe("ok");
    await slow;
  });
});

describe("deadline", () => {
  test("a call past its deadline ends with 'outcome uncertain'", async () => {
    script({ delayMs: { snapshot: 2000 } });
    const browser = runtimes({ callTimeoutMs: 200 }).forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    await expect(browser.call(["snapshot"])).rejects.toThrow(
      /outcome uncertain.*take a snapshot before retrying/,
    );
  });
});

describe("idle close", () => {
  test("closes an unused browser, keeps its saved logins, and tells the bot on its next call", async () => {
    let clock = 1_000_000;
    const rt = runtimes({ now: () => clock, idleMs: 600_000 });
    const browser = rt.forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    saveState();

    clock += 599_000;
    await rt.sweep();
    expect(closedSessions()).toEqual([]);

    clock += 2_000;
    await rt.sweep();
    expect(closedSessions()).toEqual([sessionName(BOT)]);
    expect(existsSync(statePath())).toBe(true);
    expect(browser.generation()).toBe(1);

    await browser.call(["open", "https://a.test"]);
    const reopen = calls().at(-1)!.argv;
    expect(reopen).toContain("--restore");
    expect(browser.takeNotice()).toMatch(/closed after sitting idle.*take a new snapshot/);
    expect(browser.takeNotice()).toBeUndefined();
  });

  test("never closes a browser that is in the middle of a call", async () => {
    let clock = 0;
    const rt = runtimes({ now: () => clock, idleMs: 10 });
    const browser = rt.forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    clock += 1000;
    const running = browser.exclusive(async () => {
      await rt.sweep();
      return "done";
    });
    expect(await running).toBe("done");
    expect(closedSessions()).toEqual([]);
  });
});

describe("sweep", () => {
  test("closes claudebot sessions no live runtime owns and leaves everything else alone", async () => {
    const live = "33333333-3333-4333-8333-333333333333";
    const rt = runtimes();
    await rt.forBot(live).call(["open", "https://a.test"]);
    seedSessions([sessionName(live), "claudebot-orphan-1", "someone-elses"]);
    await rt.sweep();
    expect(closedSessions()).toEqual(["claudebot-orphan-1"]);
  });

  test("start() sweeps at boot", async () => {
    seedSessions(["claudebot-crash-leftover"]);
    const rt = runtimes();
    rt.start();
    await rt.sweep();
    await rt.closeAll();
    expect(closedSessions()).toContain("claudebot-crash-leftover");
  });

  test("an orphaned engine process tree is killed when it ignores the close", async () => {
    const daemon = await fakeDaemon("orphan-9", { ignoreTerm: true });
    seedSessions([sessionName("orphan-9")]);
    await runtimes({ closeDeadlineMs: 400 }).sweep();
    await expectDead(daemon);
  });
});

describe("restart", () => {
  test("invalidates refs (generation) and tells the bot once", async () => {
    const rt = runtimes();
    const browser = rt.forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    expect(browser.generation()).toBe(0);
    await rt.restart(BOT);
    expect(browser.generation()).toBe(1);
    expect(browser.takeNotice()).toMatch(/was restarted.*take a new snapshot/);
    expect(browser.takeNotice()).toBeUndefined();
  });

  test("restart before any call has nothing to invalidate", async () => {
    const rt = runtimes();
    await rt.restart(BOT);
    expect(rt.forBot(BOT).generation()).toBe(0);
    expect(calls()).toEqual([]);
  });

  test("a browser that went away and came back between calls (crash) is noticed", async () => {
    const rt = runtimes();
    const browser = rt.forBot(BOT);
    await fakeDaemon(BOT);
    await browser.call(["open", "https://a.test"]);
    expect(browser.generation()).toBe(0);
    await fakeDaemon(BOT);
    await browser.call(["snapshot"]);
    expect(browser.generation()).toBe(1);
    expect(browser.takeNotice()).toMatch(/crashed/);
  });

  test("closing waits for the daemon and its Chrome to exit, killing both process groups past the deadline", async () => {
    const rt = runtimes({ closeDeadlineMs: 500 });
    const daemon = await fakeDaemon(BOT, { ignoreTerm: true });
    await rt.forBot(BOT).call(["open", "https://a.test"]);
    const started = Date.now();
    await rt.restart(BOT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    await expectDead(daemon);
  });
});

describe("headed", () => {
  test("the engine launches with a window only when the bot's setting is on, and always with the idle backstop", async () => {
    let headed = false;
    const browser = runtimes({ headed: () => headed }).forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    headed = true;
    await browser.call(["snapshot"]);
    const [c1, c2] = [
      calls().find((c) => c.argv.includes("open")),
      calls().find((c) => c.argv.includes("snapshot")),
    ];
    const first = defined(c1, "open call");
    const second = defined(c2, "snapshot call");
    expect(first.argv).not.toContain("--headed");
    expect(second.argv).toContain("--headed");
    for (const c of [first, second])
      expect(c.argv[c.argv.indexOf("--idle-timeout") + 1]).toBe(String(15 * 60_000));
  });
});

describe("viewport", () => {
  const pins = () =>
    calls()
      .filter((c) => c.argv.includes("viewport"))
      .map((c) => c.argv.slice(c.argv.indexOf("viewport")).join(" "));

  test("a started browser is pinned to 1280x720 once, and again after it restarts", async () => {
    let clock = 1_000_000;
    const rt = runtimes({ now: () => clock, idleMs: 600_000 });
    const browser = rt.forBot(BOT);
    expect(pins()).toEqual([]);
    await browser.call(["open", "https://a.test"]);
    await browser.call(["snapshot"]);
    expect(pins()).toEqual(["viewport 1280 720"]);

    clock += 700_000;
    await rt.sweep();
    await browser.call(["open", "https://a.test"]);
    expect(pins()).toEqual(["viewport 1280 720", "viewport 1280 720"]);
  });

  test("a pin the engine refuses is retried with the next call and never fails the bot's call", async () => {
    script({ fail: { set: "engine busy" } });
    const browser = runtimes().forBot(BOT);
    await browser.call(["open", "https://a.test"]);
    await browser.call(["snapshot"]);
    expect(pins()).toHaveLength(2);
  });
});

describe("sign out and bot deletion", () => {
  test("sign out closes the browser and deletes saved logins, but only this bot's", async () => {
    const rt = runtimes();
    const other = "44444444-4444-4444-8444-444444444444";
    await rt.forBot(BOT).call(["open", "https://a.test"]);
    saveState();
    saveState(other);
    await rt.signOut(BOT);
    expect(closedSessions()).toEqual([sessionName(BOT)]);
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(statePath(other))).toBe(true);
    expect(rt.forBot(BOT).takeNotice()).toMatch(/signed out of everything/);
  });

  test("sign out deletes saved logins even when no browser is running", async () => {
    saveState();
    await runtimes().signOut(BOT);
    expect(existsSync(statePath())).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("deleting a bot revokes its tokens, closes its browser, deletes saved logins and grants", async () => {
    const rt = runtimes();
    const credentials = createCredentials({
      db: migrate(new Database(":memory:")),
      secrets: memorySecrets(),
    });
    const entry = await credentials.add({
      label: "GH",
      signInUrl: "https://github.com/login",
      username: "me",
      password: "pw-pw-pw",
    });
    credentials.grant(BOT, entry.id);
    const waits = createHumanWaits({
      emit() {},
      deliver: (_botId, text) => void delivered.push(text),
    });
    const delivered: string[] = [];
    const takeover = new Takeover({
      runtimes: rt,
      waits,
      deliver: (_botId, text) => void delivered.push(text),
    });
    const endpoint = createBrowserEndpoint({
      host: agentOrigin(1),
      isEnabled: () => true,
      runtimes: rt,
      filesDir: () => root,
      egress: stubEgress(),
      takeover,
      login: createBrowserLogin({
        credentials,
        secrets: memorySecrets(),
        waits,
        botName: () => "bot",
        exchangeUrl: () => "http://127.0.0.1:1/x",
      }),
      unattended: () => false,
    });
    const token = defined(endpoint.lease(BOT).servers[0], "server").token;
    const rejected = () => fetch(`http://127.0.0.1:1/x`).catch(() => undefined);
    await rt.forBot(BOT).call(["open", "https://a.test"]);
    saveState();
    expect(credentials.hasGrant(BOT, entry.id)).toBe(true);

    takeover.request(BOT, "solve the CAPTCHA");
    await removeBotBrowser({ endpoint, runtimes: rt, takeover, credentials }, BOT);
    expect(delivered.join("\n")).toContain("cancelled");
    expect(waits.pending(BOT)).toEqual([]);
    expect(rt.forBot(BOT).controlHeld()).toBe(false);

    expect(closedSessions()).toEqual([sessionName(BOT)]);
    expect(existsSync(statePath())).toBe(false);
    expect(credentials.hasGrant(BOT, entry.id)).toBe(false);
    expect(defined(endpoint.lease(BOT).servers[0], "server").token).not.toBe(token);
    expect(await rejected()).toBeUndefined();
  });
});

describe("host routes and tool results", () => {
  let server: HostServer;
  let device: string;
  let cwd: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    cwd = join(root, `ws-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    server = await createHostServer({
      config: parseHostConfig(["--data-root", cwd], {}).config,
      cli: { path: "/nonexistent/claude", source: "CLAUDE_PATH", needsShell: false },
      db: migrate(new Database(":memory:")),
      secrets: memorySecrets(),
      browser: {
        env: { FAKE_AGENT_BROWSER_DIR: fakeDir, HOME: home, AGENT_BROWSER_SOCKET_DIR: sockets },
        laneWaitMs: 100,
      },
    });
    device = pairDevice(server);
  });

  const api = (path: string, body: object) => clientPost(server, device, path, body);
  async function enabledBot() {
    const bot = createBot(cwd, "bot");
    expect((await api("/api/bots/browser", { botId: bot.id, enabled: true })).status).toBe(200);
    const s = defined(server.browser.lease(bot.id).servers[0], "server");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
      }),
    );
    clients.push(client);
    return { bot, client };
  }
  const textOf = (r: unknown) =>
    (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
  const close = async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
  };

  test("Restart browser tells the bot in its next tool result, once", async () => {
    const { bot, client } = await enabledBot();
    await client.callTool({ name: "browser_open", arguments: { url: "https://a.test" } });
    expect((await api("/api/bots/browser/restart", { botId: bot.id })).status).toBe(200);
    const next = textOf(
      await client.callTool({ name: "browser_open", arguments: { url: "https://b.test" } }),
    );
    expect(next).toMatch(/Your browser was restarted/);
    expect(next).toContain("https://b.test");
    expect(textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }))).not.toMatch(
      /restarted/,
    );
    await close();
  });

  test("Sign out of everything closes the browser and deletes saved logins", async () => {
    const { bot, client } = await enabledBot();
    await client.callTool({ name: "browser_open", arguments: { url: "https://a.test" } });
    saveState(bot.id);
    expect((await api("/api/bots/browser/sign-out", { botId: bot.id })).status).toBe(200);
    expect(existsSync(statePath(bot.id))).toBe(false);
    expect(closedSessions()).toEqual([sessionName(bot.id)]);
    await close();
  });

  test("routes refuse an unknown bot", async () => {
    for (const p of ["restart", "sign-out", "headed"])
      expect((await api(`/api/bots/browser/${p}`, { botId: "nope", headed: true })).status).toBe(
        404,
      );
    await close();
  });

  test("the headed setting is stored (default off), rejects non-booleans, and restarts a running browser so the window shows", async () => {
    const { bot, client } = await enabledBot();
    expect(getBot(cwd, bot.id)!.browser.headed).toBe(false);
    await client.callTool({ name: "browser_open", arguments: { url: "https://a.test" } });
    expect((await api("/api/bots/browser/headed", { botId: bot.id, headed: "yes" })).status).toBe(
      400,
    );
    expect((await api("/api/bots/browser/headed", { botId: bot.id, headed: true })).status).toBe(
      200,
    );
    expect(getBot(cwd, bot.id)!.browser.headed).toBe(true);
    await client.callTool({ name: "browser_open", arguments: { url: "https://a.test" } });
    expect(
      calls()
        .filter((c) => !c.argv.includes("list"))
        .at(-1)!.argv,
    ).toContain("--headed");
    await close();
  });

  test("a tool call that cannot get the lane in time fails with 'previous browser call still running'", async () => {
    script({ delayMs: { snapshot: 1500 } });
    const { client } = await enabledBot();
    await client
      .callTool({ name: "browser_open", arguments: { url: "https://a.test" } })
      .catch(() => undefined);
    const slow = client.callTool({ name: "browser_snapshot", arguments: {} });
    await Bun.sleep(100);
    const refused = (await client.callTool({ name: "browser_snapshot", arguments: {} })) as {
      isError?: boolean;
    };
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("previous browser call still running");
    await slow;
    await close();
  });
});
