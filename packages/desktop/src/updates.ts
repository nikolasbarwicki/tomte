/** `off` in this variable disables the update check for that process. The smoke kit sets it for every launch it makes, so no smoke ever asks a feed for anything. */
export const UPDATES_ENV = "TOMTE_DESKTOP_UPDATES";

/** The first check waits, so the host and the window come up first; later checks follow at this pace. */
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What one update check reports, whichever updater library sits behind the engine. */
export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none" }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

/** The update library, reduced to what the app uses. The Electron implementation is `electron-update-engine.ts`; tests use a fake. */
export interface UpdateEngine {
  /** Asks the feed for a newer release and, when there is one, downloads it. Reports through `onEvent`; a failure is an `error` event, not a rejection. */
  check(): Promise<void>;
  onEvent(listener: (event: UpdateEvent) => void): void;
  /** Installs the downloaded update and quits. Throws when it cannot start the install. */
  quitAndInstall(): void;
}

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string }
  | { status: "ready"; version: string };

export interface Updater {
  state(): UpdateState;
  /** Called on every change of state. Returns a function that removes it. */
  onChange(listener: (state: UpdateState) => void): () => void;
  /** Schedules the first check and the ones after it. */
  start(): void;
  /** Installs the downloaded update and quits; throws when none is ready or the install cannot start. */
  quitAndInstall(): void;
  /** Cancels the schedule. */
  stop(): void;
}

/** Why no update check runs in this process, or `undefined` when one may. */
export function updatesDisabledReason(options: {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** The packaged `app-update.yml`, or `undefined` when the app has none. */
  feed: string | undefined;
}): string | undefined {
  if (options.env[UPDATES_ENV] === "off") return `${UPDATES_ENV}=off`;
  if (!options.isPackaged) return "the app is not packaged";
  if (options.feed === undefined) return "the app has no app-update.yml";
  if (isPlaceholderFeed(options.feed)) return "the update feed is the local-build placeholder";
  return undefined;
}

/** A local build's metadata names the reserved `.invalid` host (see `updateProvider` in scripts/desktop-kit.ts); asking it would only ever fail. */
export function isPlaceholderFeed(appUpdateYml: string): boolean {
  const url = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(appUpdateYml)?.[1];
  if (url === undefined) return false;
  try {
    return new URL(url).hostname.endsWith(".invalid");
  } catch {
    return false;
  }
}

/** A pre-release suffix (`1.2.0-rc.1`) makes a version a pre-release; a build suffix (`+abc`) does not. */
export function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version.split("+")[0] ?? "");
}

/** A line fit for the log when the host the app started does not report the app's own version, `undefined` when they match. */
export function hostVersionMismatch(hostVersion: string, appVersion: string): string | undefined {
  if (hostVersion === appVersion) return undefined;
  return `the host reports version ${hostVersion} but the app is ${appVersion}; they are released together, so one of them was not updated`;
}

export interface Timers {
  /** Runs `fn` once after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

const realTimers: Timers = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/**
 * Checks for updates on a schedule and tracks where the newest one is. Nothing here can stop the app: a failed check or
 * download is logged and the next check happens on schedule.
 */
export function createUpdater(options: {
  engine: UpdateEngine;
  log: (message: string) => void;
  timers?: Timers;
  firstCheckDelayMs?: number;
  intervalMs?: number;
}): Updater {
  const { engine, log } = options;
  const timers = options.timers ?? realTimers;
  const firstDelay = options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS;
  const interval = options.intervalMs ?? CHECK_INTERVAL_MS;
  let state: UpdateState = { status: "idle" };
  let cancel: (() => void) | undefined;
  let stopped = false;
  const listeners = new Set<(state: UpdateState) => void>();

  const set = (next: UpdateState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  engine.onEvent((event) => {
    switch (event.kind) {
      case "checking":
        if (state.status === "idle") set({ status: "checking" });
        return;
      case "available":
        log(`update ${event.version} found, downloading`);
        return set({ status: "downloading", version: event.version });
      case "none":
        log("no update");
        return set(state.status === "ready" ? state : { status: "idle" });
      case "downloaded":
        log(`update ${event.version} downloaded; it installs when the app quits`);
        return set({ status: "ready", version: event.version });
      case "error":
        // A refused install (an unsigned macOS app, say) reports after the download: what was ready is not.
        log(`update failed: ${event.message}`);
        return set({ status: "idle" });
    }
  });

  async function check(): Promise<void> {
    try {
      if (state.status !== "ready") await engine.check();
    } catch (error) {
      log(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
      if (state.status !== "ready") set({ status: "idle" });
    }
    schedule(interval);
  }

  function schedule(ms: number): void {
    if (stopped) return;
    cancel = timers.after(ms, () => void check());
  }

  return {
    state: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      stopped = false;
      cancel?.();
      schedule(firstDelay);
    },
    quitAndInstall() {
      if (state.status !== "ready") throw new Error("no update has been downloaded");
      engine.quitAndInstall();
    },
    stop() {
      stopped = true;
      cancel?.();
    },
  };
}
