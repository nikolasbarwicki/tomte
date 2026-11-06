import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { SecretStore } from "../platform/secrets.ts";
import { writeActionPolicy } from "./action-policy.ts";
import type { EgressProxy } from "./egress-proxy.ts";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  EngineError,
  findChrome,
  listSessions,
  restoreStatePath,
  runEngine,
  SESSION_PREFIX,
  sessionName,
  socketDir,
  type EngineLaunch,
} from "./engine-cli.ts";
import { resolveEngine } from "./engine.ts";
import { Lane } from "./lane.ts";
import { chromePid, engineTree, isAlive, killTree, readPid, waitForExit } from "./process.ts";

const KEY_SECRET = "browser-encryption-key";

const USER_HAS_CONTROL = "user has control";

/** The engine or Chrome is missing, so no browser call can run. */
export class BrowserUnavailable extends Error {}

export interface BrowserRuntimeOptions {
  /** Extra environment for engine processes. */
  env?: Record<string, string>;
  callTimeoutMs?: number;
  /** Whether a bot's browser shows its window; read at every engine launch. */
  headed?: (botId: string) => boolean;
  /** How long a second call waits for the bot's lane before failing. Default 30 s. */
  laneWaitMs?: number | undefined;
  /** A browser unused this long is closed, keeping saved logins. Default 10 minutes. */
  idleMs?: number;
  /** Time the engine gets to close the browser before its processes are killed. Default 10 s. */
  closeDeadlineMs?: number;
  /** How often idle browsers and orphaned sessions are swept. Default every minute. */
  sweepEveryMs?: number;
  now?: () => number;
}

/** One bot's browser. It has no engine session until the first call. */
export interface BotBrowser {
  /** Runs an engine command in this bot's session and returns its data; throws `EngineError` or `BrowserUnavailable`. */
  call(command: string[], options?: { env?: Record<string, string> }): Promise<unknown>;
  /** Runs one whole tool call as the bot's only browser call; refused with "previous browser call still running" if the lane stays busy. */
  exclusive<T>(job: () => Promise<T>): Promise<T>;
  /** Counts browser restarts the runtime has seen; element refs from an earlier generation are stale. */
  generation(): number;
  /** What the bot must be told about its browser (restart, failed restore) before its next result; each message is delivered once. */
  takeNotice(): string | undefined;
  /** True once this bot's engine session has been started by a call; reading it never starts anything. */
  active(): boolean;
  /** The engine's live stream port for a started session; undefined when the session was never started. Never starts a browser. */
  streamPort(): Promise<number | undefined>;
  /** The user takes the browser: new bot calls are refused with "user has control" from now on; a call already running is unaffected. */
  holdControl(): void;
  /** Resolves once no bot call is running or waiting, so the user can act without a bot call interleaving. Throws `EngineError` if a call outlives its deadline. */
  awaitIdle(): Promise<void>;
  /** Returns the browser to the bot. True if any bot call was refused while the user held it. */
  releaseControl(): boolean;
  controlHeld(): boolean;
}

export interface BrowserRuntimes {
  forBot(botId: string): BotBrowser;
  /** Closes every browser that was started, keeping saved logins, and stops the sweep. */
  closeAll(): Promise<void>;
  /** Closes the bot's browser, keeping saved logins; the next call starts a fresh one. */
  restart(botId: string): Promise<void>;
  /** Closes the bot's browser and deletes its saved logins. */
  signOut(botId: string): Promise<void>;
  /** Sign-out, then forgets the bot's runtime. For bot deletion. */
  remove(botId: string): Promise<void>;
  /** Starts the boot sweep and the periodic one. */
  start(): void;
  /** Closes idle browsers and engine sessions with claudebot's prefix that no live runtime owns. */
  sweep(): Promise<void>;
}

interface BotState {
  lane: Lane;
  /** A browser was started and not closed by this runtime. */
  live: boolean;
  lastUsed: number;
  restarts: number;
  notices: string[];
  /** Daemon and Chrome pids at the last call; a change means the browser went away and came back. */
  fingerprint?: string | undefined;
  restoreWarned: boolean;
  /** The user holds the browser; bot calls are refused. */
  held: boolean;
  refused: boolean;
}

/** The engine key is generated once and lives in the secret store; it is never written to disk. */
async function engineKey(secrets: SecretStore): Promise<string> {
  const stored = await secrets.get(KEY_SECRET);
  if (stored) return stored;
  const key = randomBytes(32).toString("hex");
  await secrets.set(KEY_SECRET, key);
  return key;
}

export function createBrowserRuntimes(
  secrets: SecretStore,
  egress: EgressProxy,
  dataRoot: string,
  o: BrowserRuntimeOptions = {},
): BrowserRuntimes {
  const bots = new Map<string, BotState>();
  let key: Promise<string> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  const now = o.now ?? Date.now;
  const timeoutMs = o.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const laneWaitMs = o.laneWaitMs ?? 30_000;
  const idleMs = o.idleMs ?? 10 * 60_000;
  const closeDeadlineMs = o.closeDeadlineMs ?? 10_000;
  let policy: ReturnType<typeof writeActionPolicy> | undefined;

  const state = (botId: string): BotState => {
    let s = bots.get(botId);
    if (!s)
      bots.set(
        botId,
        (s = {
          lane: new Lane(),
          live: false,
          lastUsed: now(),
          restarts: 0,
          notices: [],
          restoreWarned: false,
          held: false,
          refused: false,
        }),
      );
    return s;
  };

  async function launch(botId?: string): Promise<EngineLaunch> {
    const binary = resolveEngine(dataRoot)?.path;
    if (!binary) throw new BrowserUnavailable("the browser engine is not installed");
    const chrome = findChrome();
    if (!chrome)
      throw new BrowserUnavailable(
        "Chrome for Testing is not installed; run `bun packages/host/src/host.ts install-browser`",
      );
    key ??= engineKey(secrets).catch((e) => {
      key = undefined;
      throw e;
    });
    policy ??= writeActionPolicy();
    return {
      binary,
      chrome,
      actionPolicy: policy.file,
      encryptionKey: await key,
      proxy: egress.url,
      env: o.env,
      headed: botId ? o.headed?.(botId) : undefined,
    };
  }

  const pidFile = (botId: string) => join(socketDir(o.env), `${sessionName(botId)}.pid`);

  /** Records that the bot's browser went away; the bot hears about it with its next result. */
  function noteRestart(s: BotState, what: string) {
    s.restarts++;
    s.fingerprint = undefined;
    s.restoreWarned = false;
    s.notices.push(
      `Your browser ${what}. Open pages and element refs from before are gone; take a new snapshot before continuing.`,
    );
  }

  /** Daemon and Chrome pids; undefined when the engine leaves no pid file (or Chrome is not up yet). */
  function fingerprint(botId: string): string | undefined {
    const daemon = readPid(pidFile(botId));
    const chrome = daemon && chromePid(daemon);
    return daemon && chrome ? `${daemon}:${chrome}` : undefined;
  }

  function observe(botId: string, s: BotState, data: unknown) {
    s.lastUsed = now();
    const fp = fingerprint(botId);
    if (fp && s.fingerprint && fp !== s.fingerprint)
      noteRestart(s, "crashed or was closed and has been restarted");
    if (fp) s.fingerprint = fp;
    const restore = (data as { lifecycle?: { restoreStatus?: string } } | null)?.lifecycle
      ?.restoreStatus;
    if (restore === "load_failed" && !s.restoreWarned) {
      s.restoreWarned = true;
      s.notices.push(
        "Your saved logins could not be restored, so you may be signed out. The saved copy was left untouched.",
      );
    }
  }

  async function exec(botId: string, command: string[]) {
    return runEngine(await launch(), botId, command, timeoutMs);
  }

  async function call(botId: string, command: string[], extraEnv?: Record<string, string>) {
    const l = await launch(botId);
    if (extraEnv) l.env = { ...l.env, ...extraEnv };
    const s = state(botId);
    s.live = true;
    try {
      const data = await runEngine(l, botId, command, timeoutMs);
      observe(botId, s, data);
      return data;
    } finally {
      s.lastUsed = now();
    }
  }

  /** Closes the bot's engine session (`force`: even if no pid file or runtime knows it) and waits for the daemon and Chrome to exit; past the deadline their process groups are killed. */
  async function shutdown(botId: string, force = false) {
    const daemon = readPid(pidFile(botId));
    const tree = daemon && isAlive(daemon) ? engineTree(daemon) : undefined;
    if (!tree && !force && !bots.get(botId)?.live) return;
    try {
      await runEngine(await launch(), botId, ["close"], closeDeadlineMs);
    } catch (e) {
      if (!(e instanceof EngineError || e instanceof BrowserUnavailable)) throw e;
      console.error(`[browser] closing ${botId} failed: ${e.message}`);
    }
    if (tree && !(await waitForExit(tree, closeDeadlineMs))) {
      console.error(`[browser] ${botId} did not exit in time; killing its processes`);
      killTree(tree);
    }
  }

  async function closeBrowser(botId: string, what: string) {
    const s = state(botId);
    const wasLive = s.live;
    await shutdown(botId);
    s.live = false;
    if (wasLive) noteRestart(s, what);
  }

  const forgetSavedLogins = (botId: string) => {
    const base = restoreStatePath(o.env, botId);
    for (const suffix of [".json", ".json.enc"]) rmSync(base + suffix, { force: true });
  };

  async function signOut(botId: string) {
    await closeBrowser(botId, "was signed out of everything and closed");
    forgetSavedLogins(botId);
  }

  async function closeIdle() {
    for (const [botId, s] of bots) {
      if (!s.live || s.held || s.lane.busy || now() - s.lastUsed < idleMs) continue;
      // Refused at once if a call slipped in since the check.
      await s.lane
        .run(() => closeBrowser(botId, "was closed after sitting idle"), 0)
        .catch((e) => {
          if (!(e instanceof EngineError)) throw e;
        });
    }
  }

  async function closeOrphans() {
    let sessions: string[];
    try {
      sessions = await listSessions(await launch(), timeoutMs);
    } catch (e) {
      if (e instanceof EngineError || e instanceof BrowserUnavailable) return;
      throw e;
    }
    for (const name of sessions) {
      const botId = name.startsWith(SESSION_PREFIX) ? name.slice(SESSION_PREFIX.length) : "";
      if (!/^[A-Za-z0-9-]+$/.test(botId) || bots.get(botId)?.live) continue;
      console.error(`[browser] closing orphaned session ${name}`);
      await shutdown(botId, true);
    }
  }

  function sweep() {
    sweeping ??= (async () => {
      try {
        await closeIdle();
        await closeOrphans();
      } catch (e) {
        console.error(`[browser] sweep failed: ${(e as Error).message}`);
      } finally {
        sweeping = undefined;
      }
    })();
    return sweeping;
  }

  return {
    forBot(botId) {
      const s = state(botId);
      return {
        call: (command, options) => call(botId, command, options?.env),
        exclusive: async (job) => {
          // Checked again once the call reaches the front of the lane: a takeover may have started while it queued.
          const refuse = () => {
            if (!s.held) return;
            s.refused = true;
            throw new EngineError(USER_HAS_CONTROL);
          };
          refuse();
          return s.lane.run(async () => {
            refuse();
            return job();
          }, laneWaitMs);
        },
        holdControl: () => void (s.held = true),
        awaitIdle: () => s.lane.run(async () => {}, timeoutMs + laneWaitMs),
        releaseControl() {
          const refused = s.refused;
          s.held = false;
          s.refused = false;
          s.lastUsed = now();
          return refused;
        },
        controlHeld: () => s.held,
        generation: () => s.restarts,
        takeNotice: () => s.notices.splice(0).join("\n") || undefined,
        active: () => s.live,
        async streamPort() {
          if (!s.live) return undefined;
          const status = (await exec(botId, ["stream", "status"])) as {
            enabled?: boolean;
            port?: number;
          };
          return status.enabled && typeof status.port === "number" ? status.port : undefined;
        },
      };
    },
    start() {
      void sweep();
      ticker ??= setInterval(() => void sweep(), o.sweepEveryMs ?? 60_000);
      ticker.unref();
    },
    sweep,
    restart: (botId) => closeBrowser(botId, "was restarted"),
    signOut,
    async remove(botId) {
      await signOut(botId);
      bots.delete(botId);
    },
    async closeAll() {
      clearInterval(ticker);
      ticker = undefined;
      await Promise.all(
        [...bots]
          .filter(([, s]) => s.live)
          .map(([id, s]) => shutdown(id).then(() => void (s.live = false))),
      );
      if (policy) rmSync(policy.dir, { recursive: true, force: true });
      policy = undefined;
    },
  };
}
