// Shared whole-host setup for handoff tests: the real host server, the fake Claude CLI and MCP clients acting as bots.
// Each test file starts its own host with `startHandoffHost()` and stops it with `stop()`; `hostFlags` are command-line flags for the host's config.
// The data root is a temp directory and the database is in memory, unless `hostFlags` carries `--data-root`: then the database is a file in that data root. `cwd` is the host's workspace directory inside the data root.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
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
import { acquireDataRootLock, type DataRootLock } from "../platform/data-root-lock.ts";
import { migrate, openDb } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { ensureWorkspace } from "../platform/workspace.ts";

const FAKE_ENGINE = join(import.meta.dir, "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const ENV_KEYS = [
  "AGENT_BROWSER_PATH",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "FAKE_CLAUDE_DIR",
] as const;

export type ToolResult = { isError: boolean; text: string };
export type BotCaller = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

export interface HandoffHost {
  server: HostServer;
  /** The workspace directory the host runs every bot's Claude CLI in. */
  cwd: string;
  /** The data root the host runs on. */
  dataRoot: string;
  /** Creates a bot; its first session id is its bot id. */
  createBot(name: string, purpose?: string): string;
  /** An MCP client connected to the bots endpoint with a token from a fresh bots lease for `botId`. */
  actAs(botId: string): Promise<{ call: BotCaller; token: string; url: string; revoke(): void }>;
  /** Texts the fake CLI received for the bot's first session, oldest first. */
  messagesOf(botId: string): string[];
  /** CLI launches the fake CLI recorded: the directory it ran in, the system prompt addition and the MCP servers it was given. */
  launches(): {
    cwd: string;
    appendSystemPrompt?: string;
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  }[];
  /** From now on, every message the fake CLI receives makes it call the host's `remember` tool with this line. */
  rememberOnMessage(scope: "user" | "bot", line: string): void;
  /** While held, a message the fake CLI receives keeps its turn running. */
  hold(): void;
  release(): void;
  /** POST to a host UI route, as the web page does. */
  ui(path: string, body: object): Promise<Response>;
  /** Waits until `check` holds, then asserts it. */
  until(check: () => boolean, ms?: number): Promise<void>;
  /** Closes the host and starts a new one on the same database and data root; `server` is replaced. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHandoffHost(hostFlags: string[] = []): Promise<HandoffHost> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handoffs-test-")));
  const dataRoot = join(root, "ws");
  const fakeDir = join(root, "fake");
  const claudeDir = join(root, "claude");
  for (const d of [dataRoot, fakeDir, claudeDir]) mkdirSync(d, { recursive: true });
  const chrome = join(root, "chrome");
  writeFileSync(chrome, "");
  process.env.AGENT_BROWSER_PATH = FAKE_ENGINE;
  process.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
  process.env.FAKE_CLAUDE_DIR = claudeDir;

  const config = parseHostConfig(["--data-root", dataRoot, ...hostFlags], {}).config;
  const restoreEnv = () => {
    for (const k of ENV_KEYS)
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  };
  let lock: DataRootLock;
  try {
    lock = acquireDataRootLock(config.dataRoot);
  } catch (e) {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const cwd = ensureWorkspace(config.dataRoot);
  const db = hostFlags.includes("--data-root")
    ? openDb(config.dataRoot)
    : migrate(new Database(":memory:"));
  const secrets = memorySecrets();
  const startServer = () =>
    createHostServer({
      config,
      cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
      db,
      secrets,
      browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
      sandbox: () => ({ status: "available" }),
    });
  let server = await startServer();
  const clients: Client[] = [];
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  const host: HandoffHost = {
    get server() {
      return server;
    },
    cwd,
    dataRoot: config.dataRoot,
    createBot: (name, purpose) => createBot(config.dataRoot, name, purpose).id,
    async actAs(botId) {
      const lease = server.bots.lease(botId);
      const [s] = lease.servers;
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(s.url), {
          requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
        }),
      );
      clients.push(client);
      const call: BotCaller = (name, args = {}) =>
        client.callTool({ name, arguments: args }).then((r) => ({
          isError: r.isError === true,
          text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
        }));
      return { call, token: s.token, url: s.url, revoke: lease.release };
    },
    messagesOf: (botId) =>
      lines(join(claudeDir, "messages.jsonl"))
        .filter((m: { sessionId: string }) => m.sessionId === botId)
        .map((m: { text: string }) => m.text),
    launches: () => lines(join(claudeDir, "launches.jsonl")),
    rememberOnMessage: (scope, line) =>
      writeFileSync(join(claudeDir, "remember.json"), JSON.stringify({ scope, line })),
    hold: () => writeFileSync(join(claudeDir, "hold"), ""),
    release: () => rmSync(join(claudeDir, "hold"), { force: true }),
    ui: (path, body) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify(body),
      }),
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
      lock.release();
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return host;
}

/** The JSON a tool returned. */
export const parse = <T = Record<string, unknown>>(r: ToolResult) => JSON.parse(r.text) as T;
