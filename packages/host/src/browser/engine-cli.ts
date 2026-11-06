import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** A failed engine call: the engine said no, did not answer in time, or could not be run. */
export class EngineError extends Error {}

/** The JSON envelope the engine prints for every `--json` call. */
const EngineReply = z.object({
  success: z.boolean().optional(),
  data: z.unknown(),
  error: z.string().nullish(),
});

/** What the engine returns for a snapshot of the active tab. */
export interface PageData {
  origin?: string;
  snapshot?: string;
}

/** Everything the host fixes about how the engine runs; nothing here comes from a bot. */
export interface EngineLaunch {
  binary: string;
  /** Chrome for Testing; the engine must never fall back to the user's own Chrome. */
  chrome: string;
  /** Action policy file passed to every engine run. */
  actionPolicy: string;
  /** 64-char hex key; reaches the engine only through its environment. */
  encryptionKey: string;
  /** The host egress proxy URL; every launch goes through it and Chrome may not bypass it for loopback. */
  proxy: string;
  /** Extra environment for the engine process (tests, host-chosen settings). */
  env?: Record<string, string> | undefined;
  /** Show the browser window. Only takes effect when the engine launches the browser. */
  headed?: boolean | undefined;
}

/** The engine shuts its own daemon down after this much inactivity; a backstop behind the host's idle close. */
const ENGINE_IDLE_TIMEOUT_MS = 15 * 60_000;

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Host variables the engine and Chrome need; the rest of the host's environment (API keys, tokens) stays out. */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "DISPLAY",
  "SystemRoot",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

/** Marks engine sessions that belong to claudebot. */
export const SESSION_PREFIX = "claudebot-";

/** Chrome bypasses any proxy for loopback by default; this makes loopback go through the egress proxy, which refuses it. */
const PROXY_NO_BYPASS = "--proxy-bypass-list=<-loopback>";

/** The engine session for a bot. */
export function sessionName(botId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(botId)) throw new EngineError("invalid bot id for an engine session");
  return `${SESSION_PREFIX}${botId}`;
}

/** Flags every engine call carries, then the command itself. */
function engineArgs(launch: EngineLaunch, botId: string, command: string[]): string[] {
  const session = sessionName(botId);
  return ["--json", "--session", session, "--restore", session, ...launchFlags(launch), ...command];
}

/** Host-fixed flags every engine run carries, session-bound or not. */
function launchFlags(launch: EngineLaunch): string[] {
  return [
    "--executable-path",
    launch.chrome,
    "--idle-timeout",
    String(ENGINE_IDLE_TIMEOUT_MS),
    ...(launch.headed ? ["--headed"] : []),
    "--action-policy",
    launch.actionPolicy,
    "--proxy",
    launch.proxy,
    "--args",
    PROXY_NO_BYPASS,
  ];
}

/** Where the engine keeps its sockets and pid files: `AGENT_BROWSER_SOCKET_DIR`, else `~/.agent-browser`. */
export function socketDir(env?: Record<string, string>): string {
  return env?.AGENT_BROWSER_SOCKET_DIR ?? join(env?.HOME ?? homedir(), ".agent-browser");
}

/** Where the engine saves a session's restore state (without the `.json`/`.json.enc` suffix). */
export function restoreStatePath(env: Record<string, string> | undefined, botId: string): string {
  const session = sessionName(botId);
  return join(env?.HOME ?? homedir(), ".agent-browser", "sessions", `${session}-${session}`);
}

function engineEnv(launch: EngineLaunch): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, ...launch.env, AGENT_BROWSER_ENCRYPTION_KEY: launch.encryptionKey };
}

/** Runs one engine command and returns its `data`; failures throw `EngineError`. */
export function runEngine(
  launch: EngineLaunch,
  botId: string,
  command: string[],
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<unknown> {
  return spawnEngine(launch, engineArgs(launch, botId, command), timeoutMs);
}

/** Names of every engine session, whoever started it. */
export async function listSessions(
  launch: EngineLaunch,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<string[]> {
  const data = (await spawnEngine(
    launch,
    ["--json", ...launchFlags(launch), "session", "list"],
    timeoutMs,
  )) as { sessions?: string[] };
  return data.sessions ?? [];
}

function spawnEngine(launch: EngineLaunch, args: string[], timeoutMs: number): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const child = spawn(launch.binary, args, {
    env: engineEnv(launch),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let timedOut = false;
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.on("error", (e) => {
    clearTimeout(timer);
    reject(new EngineError(`could not run the browser engine: ${e.message}`));
  });
  child.on("close", () => {
    clearTimeout(timer);
    if (timedOut)
      return reject(
        new EngineError(
          "outcome uncertain: the browser did not answer in time; take a snapshot before retrying",
        ),
      );
    let reply: z.infer<typeof EngineReply>;
    try {
      reply = EngineReply.parse(JSON.parse(out.trim()));
    } catch {
      return reject(
        new EngineError(
          `the browser engine returned no result${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`,
        ),
      );
    }
    if (reply.success) return resolve(reply.data);
    reject(new EngineError(reply.error || "the browser engine reported a failure"));
  });
  return promise;
}

/** Chrome for Testing as installed by the engine; `AGENT_BROWSER_EXECUTABLE_PATH` overrides it. */
export function findChrome(): string | undefined {
  const override = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;
  const root = join(homedir(), ".agent-browser", "browsers");
  if (!existsSync(root)) return undefined;
  const relative =
    process.platform === "darwin"
      ? [["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]]
      : process.platform === "win32"
        ? [["chrome.exe"]]
        : [["chrome"]];
  const versions = readdirSync(root)
    .filter((d) => d.startsWith("chrome-"))
    .sort()
    .reverse();
  for (const version of versions) {
    const dir = join(root, version);
    // Linux and Windows builds unpack into a platform folder such as chrome-linux64.
    const bases = [
      dir,
      ...readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name)),
    ];
    for (const base of bases)
      for (const rel of relative) if (existsSync(join(base, ...rel))) return join(base, ...rel);
  }
  return undefined;
}
