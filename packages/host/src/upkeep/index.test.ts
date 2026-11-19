import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateStatus } from "@tomte/contract/host-status";

import { startFakeReleaseFeed, type FakeReleaseFeed } from "../testing/fake-release-feed.ts";
import { isNewer } from "./feed.ts";
import {
  createUpkeep,
  UpdateRefused,
  type RunGate,
  type Upkeep,
  type UpkeepOptions,
} from "./index.ts";

const NOW = 1_800_000_000_000;

/** A gate whose count a test sets, the way running work would. */
function fakeGate() {
  const listeners = new Set<(active: number) => void>();
  let closed = false;
  let active = 0;
  const gate: RunGate & { setActive(n: number): void } = {
    closed: () => closed,
    active: () => active,
    close: () => void (closed = true),
    open: () => void (closed = false),
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setActive(n) {
      active = n;
      for (const l of listeners) l(n);
    },
  };
  return gate;
}

let feed: FakeReleaseFeed;
let temp: string;
let dataRoot: string;
let gate: ReturnType<typeof fakeGate>;
let snapshots: string[];
let upkeep: Upkeep | undefined;
let logged: string[];

beforeEach(() => {
  feed = startFakeReleaseFeed();
  temp = mkdtempSync(join(tmpdir(), "upkeep-"));
  dataRoot = join(temp, "data");
  gate = fakeGate();
  snapshots = [];
  logged = [];
});
afterEach(() => {
  upkeep?.stop();
  upkeep = undefined;
  feed.stop();
  rmSync(temp, { recursive: true, force: true });
});

function open(
  o: {
    version?: string;
    sidecar?: boolean;
    confPath?: string;
    every?: number;
    snapshot?: UpkeepOptions["snapshot"];
  } & Pick<UpkeepOptions, "drainOverdueMs" | "resultPollMs" | "applyTimeoutMs"> = {},
) {
  const { version, sidecar, confPath, every, snapshot, ...timing } = o;
  upkeep?.stop();
  upkeep = createUpkeep({
    version: version ?? "0.1.0",
    sidecar: sidecar ?? false,
    dataRoot,
    confPath: confPath ?? feed.conf(dataRoot),
    ...(every !== undefined && { checkEveryMs: every }),
    now: () => NOW,
    log: (line) => logged.push(line),
    gate,
    snapshot: snapshot ?? ((path) => void snapshots.push(path)),
    resultPollMs: 10,
    ...timing,
  });
  return upkeep;
}

describe("what the host can do about updates", () => {
  test("the desktop's sidecar is updated with the app and never asks the feed", async () => {
    feed.publish("0.2.0");
    const u = open({ sidecar: true });
    u.start();
    expect(await u.check()).toEqual({ status: "bundled" });
    expect(feed.asked()).toBe(0);
  });

  test("a host without the update helper's configuration cannot update itself", async () => {
    const u = open({ confPath: join(temp, "missing.conf") });
    expect(await u.check()).toEqual({
      status: "unmanaged",
      reason: "this host has no update helper installed",
    });
    expect(feed.asked()).toBe(0);
  });

  test("a configuration that is invalid, or made for another data root, says so", async () => {
    const bad = join(temp, "bad.conf");
    writeFileSync(bad, "NOT=right\n");
    const invalid = await open({ confPath: bad }).check();
    expect(invalid.status === "unmanaged" && invalid.reason).toContain("is invalid");

    const other = createUpkeep({
      version: "0.1.0",
      sidecar: false,
      dataRoot: "/var/lib/other",
      confPath: feed.conf(dataRoot),
      gate,
      snapshot: () => {},
    });
    const status = await other.check();
    other.stop();
    expect(status).toEqual({
      status: "unmanaged",
      reason: `the update helper is set up for another data root (${dataRoot})`,
    });
  });
});

describe("checking the release feed", () => {
  test("nothing newer than this host is current, as of the check", async () => {
    feed.publish("0.1.0");
    expect(await open().check()).toEqual({ status: "current", checkedAt: NOW });
  });

  test("a stable release older than a pre-release host is not an update", async () => {
    feed.publish("0.1.0");
    expect(await open({ version: "0.2.0-rc.1" }).check()).toEqual({
      status: "current",
      checkedAt: NOW,
    });
  });

  test("a newer release is available, with its notes and whether it raises the shell API", async () => {
    feed.publish("0.2.0");
    const u = open();
    expect(await u.check()).toEqual({
      status: "available",
      version: "0.2.0",
      notesUrl: `${feed.url}/owner/tomte/releases/tag/v0.2.0`,
      raisesShellApi: false,
    });
    feed.publish("0.3.0", { min: 1, max: 2 });
    const next = await u.check();
    expect(next.status === "available" && next.raisesShellApi).toBe(true);
  });

  test("a feed that cannot be reached changes nothing and is logged", async () => {
    const u = open();
    const seen: UpdateStatus[] = [];
    u.onChange((s) => seen.push(s));

    // Before any answer: nothing known, which is `current` as of 0.
    feed.answer(503);
    expect(await u.check()).toEqual({ status: "current", checkedAt: 0 });
    expect(logged.at(-1)).toContain("answered 503");

    feed.answer(undefined);
    feed.publish("0.2.0");
    const available = await u.check();
    expect(available.status).toBe("available");

    // After an answer: still what the last answer said.
    feed.answer(404);
    expect(await u.check()).toEqual(available);
    expect(logged).toHaveLength(2);
    expect(seen.map((s) => s.status)).toEqual(["current", "available"]);
  });

  test("a feed that answers with something else than a release is not believed", async () => {
    feed.publish("0.2.0");
    feed.publish("../../etc");
    expect((await open().check()).status).toBe("current");
    expect(logged).toHaveLength(1);
  });

  test("it asks on start and again on its timer, and tells a listener what changed", async () => {
    feed.publish("0.1.0");
    const u = open({ every: 20 });
    const seen: UpdateStatus[] = [];
    u.onChange((s) => seen.push(s));
    u.start();
    await until(() => seen.some((s) => s.status === "current" && s.checkedAt === NOW));
    feed.publish("0.2.0");
    await until(() => seen.some((s) => s.status === "available"));
    expect(feed.asked()).toBeGreaterThanOrEqual(2);
  });

  test("concurrent checks share one request", async () => {
    feed.publish("0.1.0");
    const u = open();
    await Promise.all([u.check(), u.check(), u.check()]);
    expect(feed.asked()).toBe(1);
  });

  test("a helper installed after start is noticed at the next check", async () => {
    const path = join(temp, "later.conf");
    const u = open({ confPath: path });
    expect((await u.check()).status).toBe("unmanaged");
    feed.publish("0.2.0");
    writeFileSync(path, await Bun.file(feed.conf(dataRoot)).text());
    expect((await u.check()).status).toBe("available");
  });
});

const updatesDir = () => join(dataRoot, "updates");
const readRequest = () => JSON.parse(readFileSync(join(updatesDir(), "request.json"), "utf8"));
/** The root helper, faked: answers the request on disk the way `apply-update` would. */
function helperAnswers(result: Record<string, unknown>, requestId = readRequest().id) {
  writeFileSync(
    join(updatesDir(), "result.json"),
    JSON.stringify({ requestId, finishedAt: NOW, ...result }),
  );
}
const updated = { outcome: "updated", from: "0.1.0", version: "0.2.0" };
const reverted = {
  outcome: "reverted",
  version: "0.2.0",
  reason: "the new host never answered",
  rolledBackTo: "0.1.0",
  snapshotRestored: true,
};

/** A host with 0.2.0 on offer, ready to be told to update. */
async function offered(o: Parameters<typeof open>[0] = {}) {
  feed.publish("0.2.0");
  const u = open(o);
  await u.check();
  return u;
}

describe("updating when idle", () => {
  test("closes the gate, counts down the running work, then snapshots, asks the helper and goes current on its answer", async () => {
    const u = await offered();
    gate.setActive(2);
    const seen: UpdateStatus[] = [];
    u.onChange((s) => seen.push(s));

    expect(await u.run({ op: "apply", when: "idle" })).toEqual({
      status: "draining",
      version: "0.2.0",
      running: 2,
      since: NOW,
      overdue: false,
    });
    expect(gate.closed()).toBe(true);
    expect(snapshots).toEqual([]);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);

    gate.setActive(1);
    expect(u.status()).toMatchObject({ status: "draining", running: 1 });
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);

    gate.setActive(0);
    await until(() => u.status().status === "applying");
    expect(snapshots).toEqual([join(updatesDir(), "pre-0.2.0.db")]);
    expect(readRequest()).toEqual({ kind: "apply", id: expect.any(String), version: "0.2.0" });
    expect(gate.closed()).toBe(true);

    // The helper replaces this process; until it is gone the gate stays closed and nothing new starts.
    helperAnswers(updated);
    await Bun.sleep(60);
    expect(u.status()).toEqual({ status: "applying", version: "0.2.0" });
    expect(gate.closed()).toBe(true);
    expect(seen.map((s) => s.status)).toEqual(["draining", "draining", "applying"]);
  });

  test("a result that says the host was not replaced reopens the gate", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "idle" });
    helperAnswers({ outcome: "unchanged", version: "0.1.0" });
    await until(() => u.status().status === "current");
    expect(gate.closed()).toBe(false);
  });

  test("only the latest database snapshot is kept", async () => {
    const snapshot = (path: string) => writeFileSync(path, "db");
    const first = await offered({ snapshot });
    mkdirSync(updatesDir(), { recursive: true });
    writeFileSync(join(updatesDir(), "pre-0.0.9.db"), "older");
    await first.run({ op: "apply", when: "now" });
    expect(existsSync(join(updatesDir(), "pre-0.2.0.db"))).toBe(true);
    expect(existsSync(join(updatesDir(), "pre-0.0.9.db"))).toBe(false);
  });

  test("a host with nothing running goes straight to applying", async () => {
    const u = await offered();
    expect(await u.run({ op: "apply", when: "idle" })).toEqual({
      status: "applying",
      version: "0.2.0",
    });
    expect(readRequest()).toMatchObject({ kind: "apply", version: "0.2.0" });
  });

  test("cancelling a drain reopens the gate and offers the update again", async () => {
    const u = await offered();
    gate.setActive(1);
    await u.run({ op: "apply", when: "idle" });
    expect(await u.run({ op: "cancel" })).toMatchObject({ status: "available", version: "0.2.0" });
    expect(gate.closed()).toBe(false);
    gate.setActive(0);
    await Bun.sleep(30);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(snapshots).toEqual([]);
  });

  test("a drain past its overdue mark stays draining and says so, and Update now still goes", async () => {
    const u = await offered({ drainOverdueMs: 30 });
    gate.setActive(1);
    await u.run({ op: "apply", when: "idle" });
    expect(u.status()).toMatchObject({ status: "draining", overdue: false });
    await until(
      () => u.status().status === "draining" && (u.status() as { overdue: boolean }).overdue,
    );
    expect(gate.closed()).toBe(true);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);

    expect(await u.run({ op: "apply", when: "now" })).toEqual({
      status: "applying",
      version: "0.2.0",
    });
    expect(readRequest().version).toBe("0.2.0");
  });

  test("the feed's next answer does not replace a drain", async () => {
    const u = await offered();
    gate.setActive(1);
    await u.run({ op: "apply", when: "idle" });
    feed.publish("0.3.0");
    expect(await u.check()).toMatchObject({ status: "draining", version: "0.2.0" });
  });
});

describe("updating now", () => {
  test("does not wait for running work: the snapshot comes first, then the request", async () => {
    const order: string[] = [];
    const u = await offered({
      snapshot: (path) => {
        order.push(`snapshot ${path.split("/").at(-1)}`);
        expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
      },
    });
    gate.setActive(3);
    expect(await u.run({ op: "apply", when: "now" })).toEqual({
      status: "applying",
      version: "0.2.0",
    });
    order.push("request");
    expect(order).toEqual(["snapshot pre-0.2.0.db", "request"]);
    expect(readRequest()).toMatchObject({ kind: "apply", version: "0.2.0" });
    expect(gate.closed()).toBe(true);
  });

  test("an update that is already applying cannot be cancelled or started twice", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "now" });
    const first = readRequest().id;
    await expect(u.run({ op: "cancel" })).rejects.toBeInstanceOf(UpdateRefused);
    await u.run({ op: "apply", when: "now" });
    expect(readRequest().id).toBe(first);
  });
});

describe("what the helper answers", () => {
  test("a reverted update fails with what was put back, and stays until it is acknowledged", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "now" });
    helperAnswers(reverted);
    await until(() => u.status().status === "failed");
    expect(u.status()).toEqual({
      status: "failed",
      version: "0.2.0",
      reason: "the new host never answered",
      rolledBackTo: "0.1.0",
    });
    expect(gate.closed()).toBe(false);
    // The feed still offers 0.2.0, but a failure the owner has not seen is not replaced.
    expect(await u.check()).toMatchObject({ status: "failed" });

    expect(await u.run({ op: "cancel" })).toMatchObject({ status: "available", version: "0.2.0" });
  });

  test("a refused request fails without a rollback", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "now" });
    helperAnswers({ outcome: "refused", reason: "the signature did not verify" });
    await until(() => u.status().status === "failed");
    expect(u.status()).toEqual({
      status: "failed",
      version: "0.2.0",
      reason: "the signature did not verify",
    });
  });

  test("a failed update can be tried again, with a new request", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "now" });
    const first = readRequest().id;
    helperAnswers({ outcome: "failed", reason: "no healthy host" });
    await until(() => u.status().status === "failed");
    expect(await u.run({ op: "apply", when: "idle" })).toMatchObject({ status: "applying" });
    expect(readRequest().id).not.toBe(first);
  });

  test("another request's result is not this one's", async () => {
    const u = await offered();
    await u.run({ op: "apply", when: "now" });
    helperAnswers(updated, "someone-else");
    await Bun.sleep(40);
    expect(u.status().status).toBe("applying");
  });

  test("a helper that never answers fails the update and reopens the gate", async () => {
    const u = await offered({ applyTimeoutMs: 30 });
    await u.run({ op: "apply", when: "now" });
    await until(() => u.status().status === "failed");
    expect(u.status()).toMatchObject({ reason: expect.stringContaining("did not report") });
    expect(gate.closed()).toBe(false);
  });

  test("a snapshot that cannot be taken stops the update before any request", async () => {
    const u = await offered({
      snapshot: () => {
        throw new Error("disk full");
      },
    });
    expect(await u.run({ op: "apply", when: "now" })).toMatchObject({
      status: "failed",
      reason: "the host could not prepare the update: disk full",
    });
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(gate.closed()).toBe(false);
    expect(logged.at(-1)).toContain("disk full");
  });
});

describe("a restart in the middle of an update", () => {
  test("the new process waits for the helper's answer with the gate closed, then goes current", async () => {
    const before = await offered();
    await before.run({ op: "apply", when: "now" });
    const request = readRequest();
    before.stop();
    gate = fakeGate();

    const after = open({ version: "0.2.0" });
    after.start();
    expect(after.status()).toEqual({ status: "applying", version: "0.2.0" });
    expect(gate.closed()).toBe(true);
    helperAnswers(updated, request.id);
    await Bun.sleep(60);
    expect(after.status().status).toBe("applying");
    expect(gate.closed()).toBe(true);

    // The helper's result is read by the process that starts after it, which is the update's.
    after.stop();
    gate = fakeGate();
    const updatedHost = open({ version: "0.2.0" });
    updatedHost.start();
    expect(updatedHost.status().status).toBe("current");
    expect(gate.closed()).toBe(false);
  });

  test("a rolled-back update shows as failed in the process the helper brings back, and again after another restart", async () => {
    const before = await offered();
    await before.run({ op: "apply", when: "now" });
    helperAnswers(reverted);
    before.stop();

    for (let restart = 0; restart < 2; restart++) {
      const after = open();
      after.start();
      expect(after.status()).toEqual({
        status: "failed",
        version: "0.2.0",
        reason: "the new host never answered",
        rolledBackTo: "0.1.0",
      });
      after.stop();
    }
  });

  test("an acknowledged failure, or a result nobody asked for, is not shown again", async () => {
    const first = await offered();
    await first.run({ op: "apply", when: "now" });
    helperAnswers(reverted);
    await until(() => first.status().status === "failed");
    await first.run({ op: "cancel" });
    first.stop();

    const after = open();
    after.start();
    expect(after.status().status).not.toBe("failed");
    expect(after.status().status).not.toBe("applying");
  });
});

describe("updating automatically", () => {
  test("is off until turned on, kept across a restart, and not offered to the desktop's sidecar", async () => {
    const u = open();
    expect(u.autoUpdate()).toBe(false);
    await u.check();
    expect(await u.run({ op: "auto", enabled: true })).toMatchObject({ status: "current" });
    expect(u.autoUpdate()).toBe(true);
    expect(open().autoUpdate()).toBe(true);

    await expect(open({ sidecar: true }).run({ op: "auto", enabled: true })).rejects.toBeInstanceOf(
      UpdateRefused,
    );
    expect(open({ sidecar: true }).autoUpdate()).toBe(false);
  });

  test("tells listeners when the setting changes", async () => {
    const u = open();
    await u.check();
    let heard = 0;
    u.onChange(() => heard++);
    await u.run({ op: "auto", enabled: true });
    expect(heard).toBe(1);
  });

  test("an update the feed offers is applied when idle, once it is on", async () => {
    const u = open();
    await u.check();
    await u.run({ op: "auto", enabled: true });
    gate.setActive(1);
    feed.publish("0.2.0");
    await u.check();
    expect(u.status()).toMatchObject({ status: "draining", version: "0.2.0" });
    gate.setActive(0);
    await until(() => existsSync(join(updatesDir(), "request.json")));
    expect(readRequest()).toMatchObject({ kind: "apply", version: "0.2.0" });
  });

  test("turning it on with an update already on offer starts it", async () => {
    const u = await offered();
    gate.setActive(1);
    await u.run({ op: "auto", enabled: true });
    expect(u.status().status).toBe("draining");
  });

  test("stays off for a host that was never turned on: an offered update waits to be asked", async () => {
    const u = await offered();
    expect(u.status().status).toBe("available");
    expect(gate.closed()).toBe(false);
  });
});

describe("actions that do not apply", () => {
  test("nothing to update to, no helper, or the desktop's own sidecar", async () => {
    feed.publish("0.1.0");
    const current = open();
    await current.check();
    await expect(current.run({ op: "apply", when: "idle" })).rejects.toThrow(
      "there is no newer release to update to",
    );
    await expect(
      open({ confPath: join(temp, "missing.conf") }).run({ op: "apply", when: "now" }),
    ).rejects.toThrow("no update helper installed");
    await expect(open({ sidecar: true }).run({ op: "apply", when: "now" })).rejects.toBeInstanceOf(
      UpdateRefused,
    );
    expect(gate.closed()).toBe(false);
  });

  test("cancel with nothing to cancel, and check, answer the status", async () => {
    const u = await offered();
    expect(await u.run({ op: "cancel" })).toMatchObject({ status: "available" });
    expect(await u.run({ op: "check" })).toMatchObject({ status: "available" });
  });
});

describe("rolling back", () => {
  const versions = (running: number, previous: number) => ({
    running: { version: "0.2.0", schemaVersion: running },
    previous: { version: "0.1.0", schemaVersion: previous },
  });

  /** A host on 0.2.0 whose helper last answered an update from 0.1.0, with the binaries at the given schemas. */
  async function updatedHost(
    o: { running?: number; previous?: number; snapshot?: boolean; result?: object } = {},
  ) {
    feed.publish("0.2.0");
    mkdirSync(updatesDir(), { recursive: true });
    if (o.snapshot === true) writeFileSync(join(updatesDir(), "pre-0.2.0.db"), "snapshot");
    helperAnswers(
      {
        outcome: "updated",
        from: "0.1.0",
        version: "0.2.0",
        ...(o.result ?? versions(o.running ?? 7, o.previous ?? 7)),
      },
      "earlier-update",
    );
    const u = open({ version: "0.2.0" });
    await u.check();
    return u;
  }

  test("is offered when the earlier version shares the database's schema", async () => {
    const u = await updatedHost();
    expect(u.status().status).toBe("current");
    expect(u.rollbackOffer()).toEqual({ kind: "rollback", version: "0.1.0" });
  });

  test("is offered as a restore of the snapshot, with its date, when the earlier version's schema is older", async () => {
    const u = await updatedHost({ running: 8, previous: 7, snapshot: true });
    const offer = u.rollbackOffer();
    expect(offer).toEqual({ kind: "restore", version: "0.1.0", snapshotAt: expect.any(Number) });
    const { mtimeMs } = statSync(join(updatesDir(), "pre-0.2.0.db"));
    expect(offer?.kind === "restore" && offer.snapshotAt).toBe(mtimeMs);
  });

  test.each([
    ["a schema change and no snapshot", { running: 8, previous: 7 }],
    ["an earlier version that needs a newer schema", { running: 7, previous: 8, snapshot: true }],
    ["no previous binary", { result: { running: { version: "0.2.0", schemaVersion: 7 } } }],
    [
      "a result about another version of this host",
      {
        result: {
          running: { version: "0.3.0", schemaVersion: 7 },
          previous: { version: "0.2.0", schemaVersion: 7 },
        },
      },
    ],
  ])("is not offered with %s", async (_why, o) => {
    const u = await updatedHost(o);
    expect(u.rollbackOffer()).toBeUndefined();
    await expect(u.run({ op: "rollback", when: "idle", restoreSnapshot: false })).rejects.toThrow(
      UpdateRefused,
    );
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(gate.closed()).toBe(false);
  });

  test("is not offered by a host that was never updated, the desktop's sidecar or a host without the helper", async () => {
    feed.publish("0.2.0");
    expect(await open({ version: "0.2.0" }).check()).toMatchObject({ status: "current" });
    expect(upkeep?.rollbackOffer()).toBeUndefined();

    mkdirSync(updatesDir(), { recursive: true });
    helperAnswers({ outcome: "updated", from: "0.1.0", version: "0.2.0", ...versions(7, 7) }, "r");
    const sidecar = open({ version: "0.2.0", sidecar: true });
    expect(sidecar.rollbackOffer()).toBeUndefined();
    await expect(
      sidecar.run({ op: "rollback", when: "idle", restoreSnapshot: false }),
    ).rejects.toThrow(UpdateRefused);

    const bad = join(temp, "bad.conf");
    writeFileSync(bad, "NOT=right\n");
    const unmanaged = open({ version: "0.2.0", confPath: bad });
    await unmanaged.check();
    expect(unmanaged.rollbackOffer()).toBeUndefined();
  });

  test("drains like an update, then writes a rollback request without taking a new snapshot", async () => {
    const u = await updatedHost({ snapshot: true });
    gate.setActive(1);
    expect(await u.run({ op: "rollback", when: "idle", restoreSnapshot: false })).toMatchObject({
      status: "draining",
      version: "0.1.0",
      rollback: true,
      running: 1,
    });
    expect(gate.closed()).toBe(true);
    expect(u.rollbackOffer()).toBeUndefined();
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);

    gate.setActive(0);
    await until(() => u.status().status === "applying");
    expect(u.status()).toEqual({ status: "applying", version: "0.1.0", rollback: true });
    expect(readRequest()).toEqual({ kind: "rollback", id: expect.any(String) });
    expect(snapshots).toEqual([]);
    expect(existsSync(join(updatesDir(), "pre-0.2.0.db"))).toBe(true);
    expect(gate.closed()).toBe(true);
  });

  test("a rolled-back result is settled by the process the helper starts, which is current with the gate open", async () => {
    const u = await updatedHost();
    await u.run({ op: "rollback", when: "now", restoreSnapshot: false });
    helperAnswers({
      outcome: "rolled-back",
      from: "0.2.0",
      version: "0.1.0",
      snapshotRestored: false,
      running: { version: "0.1.0", schemaVersion: 7 },
    });
    await Bun.sleep(60);
    expect(u.status()).toEqual({ status: "applying", version: "0.1.0", rollback: true });
    expect(gate.closed()).toBe(true);

    const next = open({ version: "0.1.0" });
    next.start();
    expect(next.status()).toMatchObject({ status: "current" });
    expect(gate.closed()).toBe(false);
    expect(next.rollbackOffer()).toBeUndefined();
  });

  test("a restart while the helper works shows the rollback applying until its result", async () => {
    const u = await updatedHost();
    await u.run({ op: "rollback", when: "now", restoreSnapshot: false });
    const next = open({ version: "0.2.0" });
    next.start();
    expect(next.status()).toEqual({ status: "applying", version: "0.1.0", rollback: true });
    expect(gate.closed()).toBe(true);
  });

  test("across a schema change nothing happens without the explicit confirmation, and the confirmation is carried in the request", async () => {
    const u = await updatedHost({ running: 8, previous: 7, snapshot: true });
    const refused = await u
      .run({ op: "rollback", when: "idle", restoreSnapshot: false })
      .catch((e: Error) => e);
    expect(refused).toBeInstanceOf(UpdateRefused);
    expect((refused as Error).message).toContain("restoring the copy taken");
    expect(u.status().status).toBe("current");
    expect(gate.closed()).toBe(false);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(u.rollbackOffer()?.kind).toBe("restore");

    await u.run({ op: "rollback", when: "idle", restoreSnapshot: true });
    expect(readRequest()).toEqual({
      kind: "rollback",
      id: expect.any(String),
      restoreSnapshot: true,
    });
    expect(existsSync(join(updatesDir(), "pre-0.2.0.db"))).toBe(true);
  });

  test("a restore nobody needs is refused, not performed", async () => {
    const u = await updatedHost();
    await expect(u.run({ op: "rollback", when: "idle", restoreSnapshot: true })).rejects.toThrow(
      "nothing needs restoring",
    );
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
  });

  test("cancelling the drain of a rollback reopens the gate and writes nothing", async () => {
    const u = await updatedHost();
    gate.setActive(1);
    await u.run({ op: "rollback", when: "idle", restoreSnapshot: false });
    expect((await u.run({ op: "cancel" })).status).toBe("current");
    expect(gate.closed()).toBe(false);
    gate.setActive(0);
    await Bun.sleep(30);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(u.rollbackOffer()).toEqual({ kind: "rollback", version: "0.1.0" });
  });

  test("Update now on an overdue rollback drain goes on rolling back", async () => {
    const u = await updatedHost();
    gate.setActive(1);
    await u.run({ op: "rollback", when: "idle", restoreSnapshot: false });
    expect(await u.run({ op: "apply", when: "now" })).toEqual({
      status: "applying",
      version: "0.1.0",
      rollback: true,
    });
    expect(readRequest().kind).toBe("rollback");
  });

  test("a refused or failed rollback is failed as a rollback, cannot be retried as an update, and is dismissed", async () => {
    const u = await updatedHost();
    await u.run({ op: "rollback", when: "now", restoreSnapshot: false });
    helperAnswers({ outcome: "refused", reason: "no previous version is kept" });
    await until(() => u.status().status === "failed");
    expect(u.status()).toEqual({
      status: "failed",
      version: "0.1.0",
      reason: "no previous version is kept",
      rollback: true,
    });
    expect(gate.closed()).toBe(false);
    await expect(u.run({ op: "apply", when: "idle" })).rejects.toThrow(UpdateRefused);
    await expect(u.run({ op: "rollback", when: "idle", restoreSnapshot: false })).rejects.toThrow(
      UpdateRefused,
    );
    expect((await u.run({ op: "cancel" })).status).toBe("current");
  });

  test("is refused while an update is under way", async () => {
    const u = await offered({ version: "0.1.0" });
    gate.setActive(1);
    await u.run({ op: "apply", when: "idle" });
    await expect(u.run({ op: "rollback", when: "now", restoreSnapshot: false })).rejects.toThrow(
      "already under way",
    );
  });
});

describe("skipping the release that was rolled back", () => {
  const skipped = {
    version: "0.2.0",
    raisesShellApi: false,
  };
  const state = () => JSON.parse(readFileSync(join(updatesDir(), "upkeep.json"), "utf8"));

  /** A host on 0.2.0, automatic updates on, that rolled back to 0.1.0; returns the upkeep of the process the helper started. */
  async function rolledBack() {
    feed.publish("0.2.0");
    mkdirSync(updatesDir(), { recursive: true });
    helperAnswers(
      {
        outcome: "updated",
        from: "0.1.0",
        version: "0.2.0",
        running: { version: "0.2.0", schemaVersion: 7 },
        previous: { version: "0.1.0", schemaVersion: 7 },
      },
      "earlier-update",
    );
    const before = open({ version: "0.2.0" });
    await before.check();
    await before.run({ op: "auto", enabled: true });
    await before.run({ op: "rollback", when: "now", restoreSnapshot: false });
    expect(before.autoUpdate()).toBe(true);
    helperAnswers({
      outcome: "rolled-back",
      from: "0.2.0",
      version: "0.1.0",
      snapshotRestored: false,
      running: { version: "0.1.0", schemaVersion: 7 },
    });
    const after = open({ version: "0.1.0" });
    after.start();
    await until(() => after.status().status === "current" && gate.closed() === false);
    await after.check();
    return after;
  }

  test("the release it left is not offered, and automatic updates stay on and do not apply it", async () => {
    const u = await rolledBack();
    expect(u.status()).toEqual({
      status: "current",
      checkedAt: NOW,
      skipped: { ...skipped, notesUrl: `${feed.url}/owner/tomte/releases/tag/v0.2.0` },
    });
    expect(u.autoUpdate()).toBe(true);
    expect(state()).toMatchObject({ autoUpdate: true, skipped: "0.2.0" });
    expect(state().pending).toBeUndefined();

    rmSync(join(updatesDir(), "request.json"));
    await u.check();
    await Bun.sleep(30);
    expect(existsSync(join(updatesDir(), "request.json"))).toBe(false);
    expect(gate.closed()).toBe(false);
    expect(u.status().status).toBe("current");
  });

  test("a failed rollback skips nothing", async () => {
    feed.publish("0.2.0");
    mkdirSync(updatesDir(), { recursive: true });
    helperAnswers(
      {
        outcome: "updated",
        from: "0.1.0",
        version: "0.2.0",
        running: { version: "0.2.0", schemaVersion: 7 },
        previous: { version: "0.1.0", schemaVersion: 7 },
      },
      "earlier-update",
    );
    const u = open({ version: "0.2.0" });
    await u.check();
    await u.run({ op: "rollback", when: "now", restoreSnapshot: false });
    helperAnswers({ outcome: "refused", reason: "no previous version is kept" });
    await until(() => u.status().status === "failed");
    await u.run({ op: "cancel" });
    expect(state().skipped).toBeUndefined();
    expect(u.status().status).toBe("current");
  });

  test("survives a restart", async () => {
    await rolledBack();
    const again = open({ version: "0.1.0" });
    again.start();
    await until(() => checkedAt(again) === NOW);
    expect(again.status()).toMatchObject({ status: "current", skipped });
  });

  test("a newer release ends the skip and is offered, and the skip is forgotten", async () => {
    const u = await rolledBack();
    await u.run({ op: "auto", enabled: false });
    feed.publish("0.3.0");
    expect(await u.check()).toMatchObject({ status: "available", version: "0.3.0" });
    expect(state().skipped).toBeUndefined();
    feed.publish("0.2.0");
    expect(await u.check()).toMatchObject({ status: "available", version: "0.2.0" });
  });

  test("a newer release is applied by automatic updates once the skip ends", async () => {
    const u = await rolledBack();
    feed.publish("0.3.0");
    await u.check();
    await until(() => u.status().status === "applying");
    expect(readRequest()).toMatchObject({ kind: "apply", version: "0.3.0" });
  });

  test("the skipped release can still be installed explicitly, and the skip ends once it runs", async () => {
    const u = await rolledBack();
    expect(await u.run({ op: "apply", when: "now" })).toEqual({
      status: "applying",
      version: "0.2.0",
    });
    expect(readRequest()).toMatchObject({ kind: "apply", version: "0.2.0" });
    expect(state().skipped).toBe("0.2.0");
    helperAnswers({ outcome: "updated", from: "0.1.0", version: "0.2.0" });

    const next = open({ version: "0.2.0" });
    next.start();
    await until(() => checkedAt(next) === NOW);
    expect(next.status()).toEqual({ status: "current", checkedAt: NOW });
    expect(state().skipped).toBeUndefined();
  });

  test("cancelling the drain of an explicit install of the skipped release shows it as skipped again", async () => {
    const u = await rolledBack();
    gate.setActive(1);
    expect(await u.run({ op: "apply", when: "idle" })).toMatchObject({
      status: "draining",
      version: "0.2.0",
    });
    expect(await u.run({ op: "cancel" })).toMatchObject({ status: "current", skipped });
  });
});

describe("version order", () => {
  test.each([
    ["0.2.0", "0.1.0", true],
    ["0.1.1", "0.1.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.2.0", "0.2.0-rc.1", true],
    ["0.2.0-rc.1", "0.2.0", false],
    ["0.2.0-rc.2", "0.2.0-rc.1", true],
    ["0.2.0-rc.10", "0.2.0-rc.9", true],
    ["0.2.0-rc.1", "0.2.0-rc", true],
    ["0.2.0-rc", "0.2.0-rc.1", false],
    ["0.2.0-rc.1", "0.2.0-beta.4", true],
    ["0.2.0-rc.1", "0.2.0-1", true],
    ["0.2.0-1", "0.2.0-rc.1", false],
    ["next", "0.1.0", false],
    ["0.2.0", "dev", false],
  ])("%s after %s: %p", (candidate, current, newer) => {
    expect(isNewer(candidate, current)).toBe(newer);
  });
});

/** When the feed last answered, as the status says; undefined unless it is `current`. */
function checkedAt(u: Upkeep) {
  const status = u.status();
  return status.status === "current" ? status.checkedAt : undefined;
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(10);
  expect(condition()).toBe(true);
}
