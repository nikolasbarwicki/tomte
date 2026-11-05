import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A failed engine call: the engine said no, did not answer in time, or could not be run. */
export class EngineError extends Error {}

/** Everything the host fixes about how the engine runs; nothing here comes from a bot. */
export interface EngineLaunch {
  binary: string;
  /** Chrome for Testing; the engine must never fall back to the user's own Chrome. */
  chrome: string;
  /** 64-char hex key; reaches the engine only through its environment. */
  encryptionKey: string;
  /** The host egress proxy URL; every launch goes through it and Chrome may not bypass it for loopback. */
  proxy: string;
  /** Extra environment for the engine process (tests, host-chosen settings). */
  env?: Record<string, string>;
}

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Host variables the engine and Chrome need; the rest of the host's environment (API keys, tokens) stays out. */
const PASSTHROUGH_ENV = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "DISPLAY", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/** Chrome bypasses any proxy for loopback by default; this makes loopback go through the egress proxy, which refuses it. */
const PROXY_NO_BYPASS = "--proxy-bypass-list=<-loopback>";

/** The engine session for a bot; the prefix marks sessions that belong to claudebot. */
export function sessionName(botId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(botId)) throw new EngineError("invalid bot id for an engine session");
  return `claudebot-${botId}`;
}

/** Flags every engine call carries, then the command itself. */
export function engineArgs(launch: EngineLaunch, botId: string, command: string[]): string[] {
  const session = sessionName(botId);
  return ["--json", "--session", session, "--restore", session, "--executable-path", launch.chrome, "--proxy", launch.proxy, "--args", PROXY_NO_BYPASS, ...command];
}

export function engineEnv(launch: EngineLaunch): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, ...launch.env, AGENT_BROWSER_ENCRYPTION_KEY: launch.encryptionKey };
}

/** Runs one engine command and returns its `data`; failures throw `EngineError`. */
export function runEngine(launch: EngineLaunch, botId: string, command: string[], timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const child = spawn(launch.binary, engineArgs(launch, botId, command), { env: engineEnv(launch), stdio: ["ignore", "pipe", "pipe"] });
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
    if (timedOut) return reject(new EngineError("outcome uncertain: the browser did not answer in time; take a snapshot before retrying"));
    let reply: { success?: boolean; data?: unknown; error?: string | null };
    try {
      reply = JSON.parse(out.trim());
    } catch {
      return reject(new EngineError(`the browser engine returned no result${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`));
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
  const versions = readdirSync(root).filter((d) => d.startsWith("chrome-")).sort().reverse();
  for (const version of versions) {
    const dir = join(root, version);
    // Linux and Windows builds unpack into a platform folder such as chrome-linux64.
    const bases = [dir, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name))];
    for (const base of bases) for (const rel of relative) if (existsSync(join(base, ...rel))) return join(base, ...rel);
  }
  return undefined;
}
