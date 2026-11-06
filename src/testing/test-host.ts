// Shared whole-host setup for handoff tests: the real host server, an in-memory database, the fake Claude CLI and MCP clients acting as bots.
// Each test file starts its own host with `startHandoffHost()` and stops it with `stop()`.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../bots/index.ts";
import { migrate } from "../platform/db.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import { memorySecrets } from "../platform/secrets.ts";

const FAKE_ENGINE = join(import.meta.dir, "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH", "FAKE_CLAUDE_DIR"] as const;

export type ToolResult = { isError: boolean; text: string };
export type BotCaller = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

export interface HandoffHost {
  server: HostServer;
  cwd: string;
  /** Creates a bot; its first session id is its bot id. */
  createBot(name: string, purpose?: string): string;
  /** An MCP client connected to the bots endpoint with a token from a fresh bots lease for `botId`. */
  actAs(botId: string): Promise<{ call: BotCaller; token: string; url: string; revoke(): void }>;
  /** Texts the fake CLI received for the bot's first session, oldest first. */
  messagesOf(botId: string): string[];
  /** CLI launches the fake CLI recorded: system prompt addition and the MCP servers it was given. */
  launches(): { appendSystemPrompt?: string; mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }[];
  /** While held, a message the fake CLI receives keeps its turn running. */
  hold(): void;
  release(): void;
  /** POST to a host UI route, as the web page does. */
  ui(path: string, body: object): Promise<Response>;
  /** Waits until `check` holds, then asserts it. */
  until(check: () => boolean, ms?: number): Promise<void>;
  /** Closes the host and starts a new one on the same database and workspace; `server` is replaced. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHandoffHost(): Promise<HandoffHost> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handoffs-test-")));
  const cwd = join(root, "ws");
  const fakeDir = join(root, "fake");
  const claudeDir = join(root, "claude");
  for (const d of [cwd, fakeDir, claudeDir]) mkdirSync(d, { recursive: true });
  const chrome = join(root, "chrome");
  writeFileSync(chrome, "");
  process.env.AGENT_BROWSER_PATH = FAKE_ENGINE;
  process.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
  process.env.FAKE_CLAUDE_DIR = claudeDir;

  const db = migrate(new Database(":memory:"));
  const secrets = memorySecrets();
  const startServer = () =>
    createHostServer({
      cwd,
      port: 0,
      cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
      db,
      secrets,
      vite: false,
      herdr: false,
      browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
      sandbox: () => ({ status: "available" }),
    });
  let server = await startServer();
  const clients: Client[] = [];
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  const host: HandoffHost = {
    get server() {
      return server;
    },
    cwd,
    createBot: (name, purpose) => createBot(cwd, name, purpose).id,
    async actAs(botId) {
      const lease = server.bots.lease(botId);
      const [s] = lease.servers;
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
      clients.push(client);
      const call: BotCaller = (name, args = {}) =>
        client.callTool({ name, arguments: args }).then((r) => ({ isError: r.isError === true, text: (r.content as { text: string }[]).map((c) => c.text).join("\n") }));
      return { call, token: s.token, url: s.url, revoke: lease.release };
    },
    messagesOf: (botId) => lines(join(claudeDir, "messages.jsonl")).filter((m: { sessionId: string }) => m.sessionId === botId).map((m: { text: string }) => m.text),
    launches: () => lines(join(claudeDir, "launches.jsonl")),
    hold: () => writeFileSync(join(claudeDir, "hold"), ""),
    release: () => rmSync(join(claudeDir, "hold"), { force: true }),
    ui: (path, body) => fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: server.url }, body: JSON.stringify(body) }),
    async until(check, ms = 4000) {
      for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
      expect(check()).toBe(true);
    },
    async restart() {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await server.close();
      server = await startServer();
    },
    async stop() {
      rmSync(join(claudeDir, "hold"), { force: true });
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await server.close();
      for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return host;
}

/** The JSON a tool returned. */
export const parse = <T = Record<string, unknown>>(r: ToolResult) => JSON.parse(r.text) as T;
