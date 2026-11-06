import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../bots.ts";
import { migrate } from "../db.ts";
import { createHostServer, type HostServer } from "../host-server.ts";
import { memorySecrets } from "../secrets.ts";
import type { CredentialEntry, ServerEvent } from "../../web/events.ts";
import { classifyAfterLogin, CREDENTIAL_EXCHANGE_PATH, LoginNonces, NONCE_TTL_MS } from "./login.ts";

const FAKE_ENGINE = join(import.meta.dir, "..", "fixtures", "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH", "FAKE_CLAUDE_DIR"] as const;

const PASSWORD = "Zq7-correct-horse-battery";
const SITE = "http://localhost:3999";
const SIGN_IN = `${SITE}/login`;
const HOME = `${SITE}/home`;

let root: string;
let cwd: string;
let fakeDir: string;
let claudeDir: string;
let server: HostServer;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const closers: (() => unknown)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "login-test-")));
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
  claudeDir = join(cwd, "claude");
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  process.env.FAKE_CLAUDE_DIR = claudeDir;
  server = await createHostServer({
    cwd,
    port: 0,
    cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
    db: migrate(new Database(":memory:")),
    secrets: memorySecrets(),
    vite: false,
    herdr: false,
    browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
    sandbox: () => ({ status: "available" }),
  });
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await server.close();
});

const until = async (check: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
  expect(check()).toBe(true);
};

const ui = (path: string, body: object) => fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: server.url }, body: JSON.stringify(body) });

const script = (extra: object = {}) =>
  writeFileSync(
    join(fakeDir, "script.json"),
    JSON.stringify({
      pages: {
        [SIGN_IN]: { title: "Sign in", snapshot: '- heading "Sign in" [level=1, ref=e1]\n- textbox "Username" [ref=e2]\n- textbox "Password" [ref=e3]\n- button "Sign in" [ref=e4]' },
        [HOME]: { title: "Home", snapshot: '- heading "Welcome" [level=1, ref=e1]\n- link "Sign out" [ref=e2]' },
        [`${SITE}/otp`]: { title: "Verify", snapshot: '- heading "Two-step verification" [level=1, ref=e1]\n- textbox "Verification code" [ref=e2]\n- button "Verify" [ref=e3]' },
      },
      logins: { [SIGN_IN]: { username: "alice", password: PASSWORD, then: HOME } },
      ...extra,
    }),
  );

const engineCalls = (): { argv: string[]; env: Record<string, string | undefined> }[] =>
  existsSync(join(fakeDir, "calls.jsonl")) ? readFileSync(join(fakeDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const loginCalls = () => engineCalls().filter((c) => c.argv.includes("auth"));
const messages = () => (existsSync(join(claudeDir, "messages.jsonl")) ? readFileSync(join(claudeDir, "messages.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : []);

/** Everything the chat page receives on /api/events, as it arrives. */
function events() {
  const received: ServerEvent[] = [];
  const raw: string[] = [];
  const abort = new AbortController();
  closers.push(() => abort.abort());
  void (async () => {
    const res = await fetch(`${server.url}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: abort.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const parts = (buffer + value).split("\n\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) {
        raw.push(p);
        received.push(JSON.parse(p.replace(/^data: /, "")));
      }
    }
  })();
  return { received, raw };
}

async function addEntry(f: { label?: string; signInUrl?: string; username?: string; password?: string } = {}) {
  const r = await ui("/api/credentials/add", { label: "Example", signInUrl: SIGN_IN, username: "alice", password: PASSWORD, ...f });
  expect(r.status).toBe(200);
  return (await r.json()) as CredentialEntry;
}

async function setup() {
  const botId = createBot(cwd, "bot").id;
  expect((await ui("/api/bots/browser", { botId, enabled: true })).status).toBe(200);
  expect((await ui("/api/open", { botId })).status).toBe(200);
  const s = server.browser.lease(botId).servers[0];
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  closers.push(() => client.close());
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }).then((r) => ({ isError: r.isError === true, text: (r.content as { text: string }[]).map((c) => c.text).join("\n") }));
  return { botId, call };
}

const answer = (id: string, action: string) => ui("/api/waits/answer", { id, action });
const waitCard = (received: ServerEvent[]) => received.find((e) => e.type === "wait") as Extract<ServerEvent, { type: "wait" }> | undefined;

/** Asks for a sign-in, answers the approval card with Allow, and waits for the resume message. */
async function allow(call: Awaited<ReturnType<typeof setup>>["call"], received: ServerEvent[], entry = "Example") {
  const wait = JSON.parse((await call("browser_login", { entry })).text) as { status: string; id: string };
  expect(wait.status).toBe("waiting_for_user");
  await until(() => !!waitCard(received));
  const before = messages().length;
  expect((await answer(wait.id, "allow")).status).toBe(200);
  await until(() => messages().length === before + 1);
  return wait;
}

describe("browser_credentials", () => {
  test("lists label and site only: no id, username or password", async () => {
    script();
    const { call } = await setup();
    await addEntry();
    await addEntry({ label: "Other", signInUrl: "https://other.example/signin", username: "bob-the-user" });
    const r = await call("browser_credentials");
    expect(JSON.parse(r.text)).toEqual([
      { label: "Example", site: SITE },
      { label: "Other", site: "https://other.example" },
    ]);
    expect(r.text).not.toContain("alice");
    expect(r.text).not.toContain("bob-the-user");
    expect(r.text).not.toContain(PASSWORD);
  });
});

describe("browser_login approval", () => {
  test("the first use asks with an Allow/Deny card; Allow stores the grant and tells the bot to call again", async () => {
    script();
    const { call, botId } = await setup();
    const entry = await addEntry();
    const feed = events();

    const first = await call("browser_login", { entry: "Example" });
    expect(first.isError).toBe(false);
    const wait = JSON.parse(first.text) as { status: string; id: string; instruction: string };
    expect(wait.status).toBe("waiting_for_user");
    expect(wait.instruction).toContain("End your turn");
    await until(() => !!waitCard(feed.received));
    expect(waitCard(feed.received)).toMatchObject({ id: wait.id, kind: "approval", actions: [{ label: "Allow" }, { label: "Deny" }] });
    expect(engineCalls()).toEqual([]);

    expect((await answer(wait.id, "allow")).status).toBe(200);
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain('allowed sign-in with "Example"');
    expect(messages()[0]).toContain("browser_login");
    const grants = ((await (await ui("/api/credentials/list", {})).json()) as CredentialEntry[]).find((e) => e.id === entry.id)!.grants;
    expect(grants.map((g) => g.botId)).toEqual([botId]);
  });

  test("a second request while the card is open does not stack another card", async () => {
    script();
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await call("browser_login", { entry: "Example" });
    const again = await call("browser_login", { entry: "Example" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("has not answered");
    await Bun.sleep(100);
    expect(feed.received.filter((e) => e.type === "wait")).toHaveLength(1);
  });

  test("Deny tells the bot, stores no grant and runs nothing in the engine", async () => {
    script();
    const { call } = await setup();
    const entry = await addEntry();
    const feed = events();
    const wait = JSON.parse((await call("browser_login", { entry: "Example" })).text) as { id: string };
    await until(() => !!waitCard(feed.received));
    await answer(wait.id, "deny");
    await until(() => messages().length === 1);
    expect(messages()[0]).toContain("denied");
    expect(((await (await ui("/api/credentials/list", {})).json()) as CredentialEntry[]).find((e) => e.id === entry.id)!.grants).toEqual([]);
    expect(engineCalls()).toEqual([]);
  });

  test("revoking the grant makes the next login ask again", async () => {
    script();
    const { call, botId } = await setup();
    const entry = await addEntry();
    const feed = events();
    await allow(call, feed.received);
    expect(JSON.parse((await call("browser_login", { entry: "Example" })).text).status).toBe("signed_in");

    expect((await ui("/api/credentials/revoke", { id: entry.id, botId })).status).toBe(200);
    const next = JSON.parse((await call("browser_login", { entry: "Example" })).text) as { status: string };
    expect(next.status).toBe("waiting_for_user");
    expect(loginCalls()).toHaveLength(1);
  });

  test("an unknown or ambiguous label fails without asking", async () => {
    script();
    const { call } = await setup();
    await addEntry({ label: "Twin" });
    await addEntry({ label: "twin" });
    expect((await call("browser_login", { entry: "Nope" })).text).toContain("no stored credential");
    expect((await call("browser_login", { entry: "Twin" })).text).toContain("several stored credentials");
  });
});

describe("browser_login", () => {
  test("signs in: the engine gets the nonce as --item and the exchange URL in its plugin config, never the password", async () => {
    script();
    const { call } = await setup();
    const entry = await addEntry();
    const feed = events();
    await allow(call, feed.received);

    const r = await call("browser_login", { entry: "Example" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ status: "signed_in", site: SITE });

    const [login] = loginCalls();
    expect(login.argv).toEqual(expect.arrayContaining(["auth", "login", entry.id, "--credential-provider", "claudebot", "--no-navigate", "--url", SIGN_IN]));
    const nonce = login.argv[login.argv.indexOf("--item") + 1];
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    const plugins = JSON.parse(login.env.AGENT_BROWSER_PLUGINS!) as { name: string; args: string[] }[];
    expect(plugins[0].name).toBe("claudebot");
    expect(plugins[0].args[1]).toBe(`${server.url}${CREDENTIAL_EXCHANGE_PATH}`);
    expect(login.env.AGENT_BROWSER_PLUGINS).not.toContain(nonce);

    const state = JSON.parse(readFileSync(join(fakeDir, "state.json"), "utf8")) as Record<string, string>;
    expect(Object.values(state)).toEqual([HOME]);
  });

  test("a bot's old refs are stale after a sign-in", async () => {
    script();
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await call("browser_open", { url: SIGN_IN });
    const snap = await call("browser_snapshot", { interactive_only: true });
    const ref = /ref=(r\d+\.e2)/.exec(snap.text)![1];
    await allow(call, feed.received);
    await call("browser_login", { entry: "Example" });
    const stale = await call("browser_click", { ref });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("stale ref");
  });

  test("a separate verification step is reported as needs_another_step, with the takeover instruction", async () => {
    script({ logins: { [SIGN_IN]: { username: "alice", password: PASSWORD, then: `${SITE}/otp` } } });
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await allow(call, feed.received);
    const r = await call("browser_login", { entry: "Example" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ status: "needs_another_step" });
    expect(r.text).toContain("browser_request_takeover");
  });

  test("a site that shows the form again is reported as failed", async () => {
    script({ logins: { [SIGN_IN]: { username: "alice", password: "not-the-one", then: HOME } } });
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await allow(call, feed.received);
    const r = await call("browser_login", { entry: "Example" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).status).toBe("failed");
  });

  test("an engine failure on a page with leftover fields is a step the credential cannot complete", async () => {
    script({ logins: { [SIGN_IN]: { username: "alice", password: PASSWORD, then: HOME, error: "Timed out waiting for password selector" } }, pages: { [SIGN_IN]: { snapshot: '- textbox "Username" [ref=e1]\n- button "Next" [ref=e2]' } } });
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await allow(call, feed.received);
    expect(JSON.parse((await call("browser_login", { entry: "Example" })).text).status).toBe("needs_another_step");
  });

  test("a sign-in page that lands on another origin is refused before anything is filled", async () => {
    const evil = "http://localhost:4000/login";
    script({ redirects: { [SIGN_IN]: evil }, pages: { [evil]: { snapshot: '- textbox "Username" [ref=e1]\n- textbox "Password" [ref=e2]' } } });
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await allow(call, feed.received);
    const r = await call("browser_login", { entry: "Example" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).status).toBe("failed");
    expect(r.text).toContain("does not match");
    const state = JSON.parse(readFileSync(join(fakeDir, "state.json"), "utf8")) as Record<string, string>;
    expect(Object.values(state)).toEqual([evil]);
  });

  test("is refused in an unattended routine run", async () => {
    script();
    const { call, botId } = await setup();
    await addEntry();
    writeFileSync(join(claudeDir, "hold"), "");
    closers.push(() => rmSync(join(claudeDir, "hold"), { force: true }));
    const created = await ui("/api/routines/create", { botId, name: "nightly", instruction: "check", schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" } });
    const routine = (await created.json()) as { id: string };
    await ui("/api/routines/run", { id: routine.id });
    await until(() => messages().length === 1);
    const r = await call("browser_login", { entry: "Example" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unattended");
    expect(engineCalls()).toEqual([]);
  });
});

describe("the password stays in the keychain", () => {
  test("it appears in no tool result, event, log line, engine argument, or file under the data directory", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "info")];
    script();
    const { call } = await setup();
    await addEntry();
    const feed = events();
    const results: string[] = [];
    const tracked = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, args);
      results.push(r.text);
      return r;
    };
    await tracked("browser_credentials");
    const wait = JSON.parse((await tracked("browser_login", { entry: "Example" })).text) as { id: string };
    await until(() => !!waitCard(feed.received));
    await answer(wait.id, "allow");
    await until(() => messages().length === 1);
    expect(JSON.parse((await tracked("browser_login", { entry: "Example" })).text).status).toBe("signed_in");
    await tracked("browser_snapshot");
    await Bun.sleep(100);

    const everything = [...results, ...feed.raw, ...messages(), ...logs.flatMap((l) => l.mock.calls.map((c) => c.map(String).join(" "))), JSON.stringify(engineCalls())];
    for (const text of everything) expect(text).not.toContain(PASSWORD);

    const scan = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? scan(path) : [path];
      });
    for (const file of scan(cwd).filter((f) => f !== join(fakeDir, "script.json"))) expect(readFileSync(file).includes(PASSWORD), file).toBe(false);
    logs.forEach((l) => l.mockRestore());
  });
});

describe("the credential exchange", () => {
  const exchange = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${CREDENTIAL_EXCHANGE_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("a nonce that was already used gets nothing, and so does a guess", async () => {
    script();
    const { call } = await setup();
    await addEntry();
    const feed = events();
    await allow(call, feed.received);
    await call("browser_login", { entry: "Example" });
    const [login] = loginCalls();
    const nonce = login.argv[login.argv.indexOf("--item") + 1];

    const replay = await exchange({ nonce, url: SIGN_IN });
    expect(replay.status).toBe(403);
    expect(await replay.text()).not.toContain(PASSWORD);
    expect((await exchange({ nonce: "guess", url: SIGN_IN })).status).toBe(403);
  });

  test("refuses a browser page: a request carrying an Origin header", async () => {
    expect((await exchange({ nonce: "x", url: SIGN_IN }, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("refuses a request for another Host", async () => {
    const res = await fetch(`${server.url}${CREDENTIAL_EXCHANGE_PATH}`, { method: "POST", headers: { host: "rebind.example" }, body: "{}" }).catch(() => undefined);
    expect(res === undefined || res.status === 403).toBe(true);
  });
});

describe("login nonces", () => {
  const entry = { id: "e1", origin: SITE };

  test("works once: the second redeem finds nothing", () => {
    const nonces = new LoginNonces();
    const n = nonces.issue("bot", entry);
    expect(nonces.redeem(n, SIGN_IN)).toEqual({ botId: "bot", entryId: "e1" });
    expect(nonces.redeem(n, SIGN_IN)).toBeUndefined();
  });

  test("expires after 60 seconds", () => {
    let now = 1_000;
    const nonces = new LoginNonces(() => now);
    const fresh = nonces.issue("bot", entry);
    now += NONCE_TTL_MS;
    expect(nonces.redeem(fresh, SIGN_IN)).toBeDefined();
    const late = nonces.issue("bot", entry);
    now += NONCE_TTL_MS + 1;
    expect(nonces.redeem(late, SIGN_IN)).toBeUndefined();
  });

  test("a wrong scheme, host or port gets nothing, and burns the nonce", () => {
    const nonces = new LoginNonces();
    for (const url of ["https://localhost:3999/login", "http://localhost.evil.example:3999/login", "http://localhost:4000/login", "not a url"]) {
      const n = nonces.issue("bot", entry);
      expect(nonces.redeem(n, url)).toBeUndefined();
      expect(nonces.redeem(n, SIGN_IN)).toBeUndefined();
    }
  });

  test("a revoked nonce gets nothing", () => {
    const nonces = new LoginNonces();
    const n = nonces.issue("bot", entry);
    nonces.revoke(n);
    expect(nonces.redeem(n, SIGN_IN)).toBeUndefined();
  });
});

describe("what a sign-in left behind", () => {
  test("verification, form and no-field pages", () => {
    expect(classifyAfterLogin('- textbox "Verification code" [ref=e1]', false)).toBe("needs_another_step");
    expect(classifyAfterLogin('- textbox "Password" [ref=e1]', false)).toBe("failed");
    expect(classifyAfterLogin('- heading "Welcome" [ref=e1]\n- textbox "Search" [ref=e2]', false)).toBe("signed_in");
    expect(classifyAfterLogin('- textbox "Username" [ref=e1]', true)).toBe("needs_another_step");
    expect(classifyAfterLogin("(no interactive elements)", true)).toBe("failed");
  });
});
