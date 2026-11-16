// Shared whole-host setup for handoff tests: the real host server, the fake Claude CLI and MCP clients acting as bots.
// Each test file starts its own host with `startHandoffHost()` and stops it with `stop()`; `hostFlags` are command-line flags for the host's config and `ui` is the built web UI the client listener serves.
// The data root is a temp directory and the database is in memory, unless `hostFlags` carries `--data-root`: then the database is a file in that data root. `cwd` is the host's workspace directory inside the data root.
// The host runs the fake CLI through a wrapper script that names the fake's state directory on its command line, so the fake needs nothing from its environment.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import {
  chmodSync,
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
import { createHostServer, type HostServer, type HostServerOptions } from "../host-server/index.ts";
import { parseHostConfig, type HostSystem } from "../platform/config.ts";
import { acquireDataRootLock, type DataRootLock } from "../platform/data-root-lock.ts";
import { migrate, openDb } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { ensureWorkspace } from "../platform/workspace.ts";
import type { UiAssets } from "../ui/index.ts";
import { defined } from "./defined.ts";
import { asDevice, pairDevice } from "./paired-device.ts";

const FAKE_ENGINE = join(import.meta.dir, "fake-agent-browser.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const ENV_KEYS = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH"] as const;

/** Remote mode parses on Linux only; the data root is explicit, so tests on any OS can name it. */
const LINUX: HostSystem = { platform: "linux", home: tmpdir() };

export type ToolResult = { isError: boolean; text: string };
export type BotCaller = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

export interface HandoffHost {
  server: HostServer;
  /** The workspace directory the host runs every bot's Claude CLI in. */
  cwd: string;
  /** The data root the host runs on. */
  dataRoot: string;
  /** The host's database. */
  db: Database;
  /** Creates a bot; its first session id is its bot id. */
  createBot(name: string, purpose?: string): string;
  /** Names of the secrets the host holds in its (in-memory) secret store. */
  secretNames(): string[];
  /** An MCP client connected to the bots endpoint with a token from a fresh bots lease for `botId`. */
  actAs(botId: string): Promise<{ call: BotCaller; token: string; url: string; revoke(): void }>;
  /** Texts the fake CLI received for the bot's first session, oldest first. */
  messagesOf(botId: string): string[];
  /** The user messages the fake CLI received for the bot's first session, with the flags the host sent them with. */
  messageRecords(botId: string): {
    text: string;
    isSynthetic?: boolean;
    priority?: string;
    origin?: { kind: string };
  }[];
  /** CLI launches the fake CLI recorded: the directory it ran in, the system prompt addition, the MCP servers it was given, the whole environment it started with and its command line. */
  launches(): {
    cwd: string;
    appendSystemPrompt?: string;
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
    env: Record<string, string>;
    argv: string[];
  }[];
  /** The `set_model` and `apply_flag_settings` control requests the fake CLI received, oldest first. */
  controls(): { subtype: string; model?: string; settings?: { effortLevel?: string } }[];
  /** The browser engine invocations the fake engine recorded, oldest first. */
  engineCalls(): { argv: string[] }[];
  /** From now on, every message the fake CLI receives makes it call the host's `remember` tool with this line. */
  rememberOnMessage(scope: "user" | "bot", line: string): void;
  /**
   * From now on, every message the fake CLI receives makes it call the host's `ask_user` tool with these arguments.
   * `claim.eventId` is the `event_id` it passes, `claim.delivered` makes it pass the external event wrapped in the message that triggered the call (as a bot following the host's instructions would), `claim.afterHold` makes the call wait until `release()`, and `claim.crash` makes the CLI exit with the question unanswered.
   */
  askOnMessage(
    question: string,
    options?: string[],
    claim?: { eventId?: string; delivered?: boolean; afterHold?: boolean; crash?: boolean },
  ): void;
  /** From now on, messages the fake CLI receives no longer make it call `ask_user`. */
  stopAsking(): void;
  /** The text of each `ask_user` or `remember` result the fake CLI got back from the host, oldest first. */
  toolResults(): string[];
  /**
   * Scripts what the fake CLI emits per user message, as the double-loop front's query would (see the header of `fake-claude.ts`
   * for the steps). Each script runs for one message; a message takes the first unused script whose `match` it contains.
   */
  loopScript(...scripts: { match?: string; steps: Record<string, unknown>[] }[]): void;
  /** Lets a script step `waitFor` the file `name` stop waiting. */
  allow(name: string): void;
  /** What the host's hooks answered to the script's hook calls, oldest first. */
  hookResults(): {
    hook: string;
    input: Record<string, unknown>;
    callback: string | null;
    response: unknown;
  }[];
  /** What the host's in-process MCP servers answered to the script's tool calls, oldest first. */
  loopCalls(): {
    server: string;
    tool: string;
    result?: { content: { text: string }[]; isError?: boolean };
  }[];
  /** The executable the host runs as its Claude CLI, and what its `auth status` reports from now on. */
  readonly cliPath: string;
  setSignedIn(signedIn: boolean): void;
  /** The exit code the fake's `auth login` returns from now on. */
  setLoginExit(code: number): void;
  /** Whether the host finds the shell sandbox usable from now on; it starts out usable. */
  setSandboxAvailable(available: boolean): void;
  /** While held, a message the fake CLI receives keeps its turn running. */
  hold(): void;
  release(): void;
  /** The client listener's URL: the web UI and `/api/*`. Follows `restart()`. */
  readonly clientUrl: string;
  /** The agent listener's URL: the browser and bots endpoints. Follows `restart()`. */
  readonly agentUrl: string;
  /** The device token of a device paired with this host; it survives `restart()`. */
  readonly deviceToken: string;
  /** Request headers that authenticate as that device, for `fetch` calls to the client listener. */
  readonly authHeaders: { authorization: string };
  /** POST to a host UI route on the client listener, as the web page does, from the paired device. */
  ui(path: string, body: object): Promise<Response>;
  /** Waits until `check` holds, then asserts it. */
  until(check: () => boolean, ms?: number): Promise<void>;
  /** Moves the clock that pairing codes expire by forward; nothing sleeps. It survives `restart()`. */
  advanceClock(ms: number): void;
  /** Closes the host and starts a new one on the same database and data root; `server` is replaced. `hostFlags` replaces the flags the host started with. */
  restart(hostFlags?: string[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startHandoffHost(
  hostFlags: string[] = [],
  ui?: UiAssets,
  /** Stands in for the OS file manager, so a test sees what the host would reveal and never launches one. */
  reveal?: HostServerOptions["reveal"],
  /** Overrides for the host's timing, so a test need not wait out the defaults. */
  timing?: Pick<HostServerOptions, "frontIdleMs">,
): Promise<HandoffHost> {
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
  const cliPath = join(root, "claude-wrapper");
  writeFileSync(
    cliPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} ${JSON.stringify(claudeDir)} "$@"\n`,
  );
  chmodSync(cliPath, 0o755);

  let config = parseHostConfig(["--data-root", dataRoot, ...hostFlags], {}, LINUX).config;
  const restoreEnv = () => {
    for (const k of ENV_KEYS)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
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
  let clock = Date.now();
  let sandboxAvailable = true;
  const startServer = () =>
    createHostServer({
      config,
      cli: { path: cliPath, source: "CLAUDE_PATH", needsShell: false },
      db,
      secrets,
      browser: { env: { FAKE_AGENT_BROWSER_DIR: fakeDir } },
      sandbox: () =>
        sandboxAvailable
          ? { status: "available" }
          : { status: "unavailable", reason: "no sandbox in this test" },
      ...(reveal !== undefined && { reveal }),
      ...timing,
      now: () => clock,
      ...(ui !== undefined && { ui }),
    });
  let server = await startServer();
  const deviceToken = pairDevice(server);
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
    get clientUrl() {
      return server.clientUrl;
    },
    get agentUrl() {
      return server.agentUrl;
    },
    deviceToken,
    secretNames: () => [...secrets.entries.keys()],
    authHeaders: asDevice(deviceToken),
    cwd,
    dataRoot: config.dataRoot,
    db,
    createBot: (name, purpose) => createBot(config.dataRoot, name, purpose).id,
    async actAs(botId) {
      const lease = server.bots.lease(botId);
      const s = defined(lease.servers[0], "server");
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
    messageRecords: (botId) =>
      lines(join(claudeDir, "messages.jsonl")).filter(
        (m: { sessionId: string }) => m.sessionId === botId,
      ),
    launches: () => lines(join(claudeDir, "launches.jsonl")),
    controls: () => lines(join(claudeDir, "controls.jsonl")),
    engineCalls: () => lines(join(fakeDir, "calls.jsonl")),
    rememberOnMessage: (scope, line) =>
      writeFileSync(join(claudeDir, "remember.json"), JSON.stringify({ scope, line })),
    askOnMessage: (question, options, claim) =>
      writeFileSync(
        join(claudeDir, "ask.json"),
        JSON.stringify({
          question,
          ...(options && { options }),
          ...(claim?.eventId !== undefined && { event_id: claim.eventId }),
          ...(claim?.delivered && { linkDelivered: true }),
          ...(claim?.afterHold && { afterHold: true }),
          ...(claim?.crash && { crash: true }),
        }),
      ),
    stopAsking: () => rmSync(join(claudeDir, "ask.json"), { force: true }),
    toolResults: () =>
      lines(join(claudeDir, "tool-results.jsonl")).map(
        (m: { result: { content: { text: string }[] } }) => m.result.content[0]?.text ?? "",
      ),
    loopScript: (...scripts) =>
      writeFileSync(join(claudeDir, "loop.json"), JSON.stringify({ scripts })),
    allow: (name) => writeFileSync(join(claudeDir, name), ""),
    hookResults: () => lines(join(claudeDir, "hook-results.jsonl")),
    loopCalls: () => lines(join(claudeDir, "tool-results.jsonl")),
    cliPath,
    setSignedIn: (signedIn) =>
      signedIn
        ? rmSync(join(claudeDir, "signed-out"), { force: true })
        : writeFileSync(join(claudeDir, "signed-out"), ""),
    setLoginExit: (code) => writeFileSync(join(claudeDir, "login-exit"), String(code)),
    setSandboxAvailable: (available) => {
      sandboxAvailable = available;
    },
    hold: () => writeFileSync(join(claudeDir, "hold"), ""),
    release: () => rmSync(join(claudeDir, "hold"), { force: true }),
    advanceClock: (ms) => {
      clock += ms;
    },
    ui: (path, body) =>
      fetch(`${server.clientUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.clientUrl,
          ...asDevice(deviceToken),
        },
        body: JSON.stringify(body),
      }),
    async until(check, ms = 4000) {
      for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
      expect(check()).toBe(true);
    },
    async restart(flags) {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await server.close();
      if (flags)
        config = parseHostConfig(["--data-root", config.dataRoot, ...flags], {}, LINUX).config;
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
