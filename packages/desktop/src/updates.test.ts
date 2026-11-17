import { describe, expect, test } from "bun:test";

import {
  createUpdater,
  hostVersionMismatch,
  isPlaceholderFeed,
  isPrerelease,
  UPDATES_ENV,
  updatesDisabledReason,
  type Timers,
  type UpdateEngine,
  type UpdateEvent,
} from "./updates.ts";

const GITHUB_FEED = "provider: github\nowner: acme\nrepo: tomte\n";
const PLACEHOLDER_FEED = "provider: generic\nurl: https://updates.invalid/tomte\n";
const LOOPBACK_FEED = "provider: generic\nurl: http://127.0.0.1:4555\n";

describe("when updates are off", () => {
  const packaged = { env: {}, isPackaged: true, feed: GITHUB_FEED };

  test("a packaged app with a real feed checks", () => {
    expect(updatesDisabledReason(packaged)).toBeUndefined();
    expect(updatesDisabledReason({ ...packaged, feed: LOOPBACK_FEED })).toBeUndefined();
  });

  test("the off-switch wins over everything else", () => {
    expect(updatesDisabledReason({ ...packaged, env: { [UPDATES_ENV]: "off" } })).toContain(
      UPDATES_ENV,
    );
  });

  test("a dev run, an app without metadata and a local build's placeholder feed never check", () => {
    expect(updatesDisabledReason({ ...packaged, isPackaged: false })).toContain("not packaged");
    expect(updatesDisabledReason({ ...packaged, feed: undefined })).toContain("app-update.yml");
    expect(updatesDisabledReason({ ...packaged, feed: PLACEHOLDER_FEED })).toContain("placeholder");
  });

  test("only the reserved .invalid host is the placeholder", () => {
    expect(isPlaceholderFeed(PLACEHOLDER_FEED)).toBe(true);
    expect(isPlaceholderFeed('url: "https://updates.invalid/x"\n')).toBe(true);
    expect(isPlaceholderFeed(GITHUB_FEED)).toBe(false);
    expect(isPlaceholderFeed("provider: generic\nurl: https://example.com/invalid\n")).toBe(false);
    expect(isPlaceholderFeed("url: not a url\n")).toBe(false);
  });
});

describe("pre-releases", () => {
  test("a version with a pre-release suffix is one; a build suffix is not", () => {
    expect(isPrerelease("0.2.0-rc.1")).toBe(true);
    expect(isPrerelease("1.0.0-beta")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
    expect(isPrerelease("1.2.3+build.7")).toBe(false);
    expect(isPrerelease("1.2.3-rc.1+build.7")).toBe(true);
  });
});

describe("the host's version", () => {
  test("a match says nothing; a mismatch names both versions", () => {
    expect(hostVersionMismatch("0.2.0", "0.2.0")).toBeUndefined();
    const text = hostVersionMismatch("0.1.0", "0.2.0");
    expect(text).toContain("0.1.0");
    expect(text).toContain("0.2.0");
  });
});

class FakeEngine implements UpdateEngine {
  checks = 0;
  installs = 0;
  /** What the next check does: emits these events, or throws. */
  next: UpdateEvent[] | Error = [{ kind: "none" }];
  installError: Error | undefined;
  private listener: (event: UpdateEvent) => void = () => {};
  check() {
    this.checks++;
    if (this.next instanceof Error) return Promise.reject(this.next);
    for (const event of this.next) this.listener(event);
    return Promise.resolve();
  }
  onEvent(listener: (event: UpdateEvent) => void) {
    this.listener = listener;
  }
  emit(event: UpdateEvent) {
    this.listener(event);
  }
  quitAndInstall() {
    this.installs++;
    if (this.installError) throw this.installError;
  }
}

class FakeTimers implements Timers {
  pending: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  after(ms: number, fn: () => void) {
    const entry = { ms, fn, cancelled: false };
    this.pending.push(entry);
    return () => void (entry.cancelled = true);
  }
  /** Fires the newest live timer and lets the check it started finish. */
  async fire() {
    const entry = this.live().at(-1);
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
    await Promise.resolve();
    await Promise.resolve();
  }
  live = () => this.pending.filter((p) => !p.cancelled);
}

function setup() {
  const engine = new FakeEngine();
  const timers = new FakeTimers();
  const logs: string[] = [];
  const updater = createUpdater({
    engine,
    timers,
    log: (m) => void logs.push(m),
    firstCheckDelayMs: 100,
    intervalMs: 1000,
  });
  return { engine, timers, logs, updater };
}

describe("the updater", () => {
  test("waits for the first delay, then checks every interval", async () => {
    const { engine, timers, updater } = setup();
    expect(engine.checks).toBe(0);
    updater.start();
    expect(timers.live().map((t) => t.ms)).toEqual([100]);
    await timers.fire();
    expect(engine.checks).toBe(1);
    expect(timers.live().map((t) => t.ms)).toEqual([1000]);
    await timers.fire();
    expect(engine.checks).toBe(2);
    expect(updater.state()).toEqual({ status: "idle" });
  });

  test("follows a newer release from found to downloaded and keeps it", async () => {
    const { engine, timers, updater, logs } = setup();
    const seen: string[] = [];
    updater.onChange((s) => void seen.push(s.status));
    engine.next = [
      { kind: "checking" },
      { kind: "available", version: "0.2.0" },
      { kind: "downloaded", version: "0.2.0" },
    ];
    updater.start();
    await timers.fire();
    expect(seen).toEqual(["checking", "downloading", "ready"]);
    expect(updater.state()).toEqual({ status: "ready", version: "0.2.0" });
    expect(logs.join("\n")).toContain("0.2.0");
  });

  test("a downloaded update is not checked for again, and a later 'no update' leaves it ready", async () => {
    const { engine, timers, updater } = setup();
    engine.next = [{ kind: "downloaded", version: "0.2.0" }];
    updater.start();
    await timers.fire();
    await timers.fire();
    expect(engine.checks).toBe(1);
    engine.emit({ kind: "none" });
    expect(updater.state()).toEqual({ status: "ready", version: "0.2.0" });
  });

  test("a failed check is logged, leaves the state idle and the schedule running", async () => {
    const { engine, timers, updater, logs } = setup();
    engine.next = new Error("getaddrinfo ENOTFOUND");
    updater.start();
    await timers.fire();
    expect(updater.state()).toEqual({ status: "idle" });
    expect(logs.join("\n")).toContain("ENOTFOUND");
    expect(timers.live().map((t) => t.ms)).toEqual([1000]);
    engine.next = [{ kind: "none" }];
    await timers.fire();
    expect(engine.checks).toBe(2);
  });

  test("an error after the download (a refused install) takes the update back", async () => {
    const { engine, timers, updater, logs } = setup();
    engine.next = [{ kind: "downloaded", version: "0.2.0" }];
    updater.start();
    await timers.fire();
    engine.emit({ kind: "error", message: "code signature did not pass validation" });
    expect(updater.state()).toEqual({ status: "idle" });
    expect(logs.join("\n")).toContain("code signature");
    expect(() => updater.quitAndInstall()).toThrow("no update");
    expect(engine.installs).toBe(0);
  });

  test("installs only a downloaded update, and reports an install that cannot start", async () => {
    const { engine, timers, updater } = setup();
    expect(() => updater.quitAndInstall()).toThrow("no update");
    engine.next = [{ kind: "downloaded", version: "0.2.0" }];
    updater.start();
    await timers.fire();
    engine.installError = new Error("the install did not start");
    expect(() => updater.quitAndInstall()).toThrow("did not start");
    engine.installError = undefined;
    updater.quitAndInstall();
    expect(engine.installs).toBe(2);
  });

  test("stop cancels the schedule for good", async () => {
    const { engine, timers, updater } = setup();
    updater.start();
    updater.stop();
    expect(timers.live()).toEqual([]);
    expect(engine.checks).toBe(0);
  });

  test("a listener that is removed hears nothing more", async () => {
    const { engine, timers, updater } = setup();
    const seen: string[] = [];
    const remove = updater.onChange((s) => void seen.push(s.status));
    remove();
    engine.next = [{ kind: "checking" }];
    updater.start();
    await timers.fire();
    expect(seen).toEqual([]);
  });
});
