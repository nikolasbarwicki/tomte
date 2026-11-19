import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { World } from "../testing/update-world.ts";
import { runUpdate } from "./apply.ts";

let w: World;
beforeEach(() => {
  w = new World();
  w.install("0.1.0");
});
afterEach(() => w.dispose());

const run = () => runUpdate(w.conf, w.deps());
const apply = (id: string, version: string) => w.request({ kind: "apply", id, version });

describe("a good release", () => {
  test("is installed, the old binary kept once, the request consumed and the result written", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    expect(w.installed().version).toBe("0.2.0");
    expect(w.previous()?.version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.2.0");
    expect(existsSync(w.requestPath)).toBe(false);
    expect(w.result()).toMatchObject({
      requestId: "r1",
      outcome: "updated",
      from: "0.1.0",
      version: "0.2.0",
      running: { version: "0.2.0" },
      previous: { version: "0.1.0" },
    });
    expect(w.database).toBe("database of 0.1.0");
  });

  test("keeps exactly one previous binary across two updates", async () => {
    w.publish({ version: "0.2.0" });
    w.publish({ version: "0.3.0" });
    apply("r1", "0.2.0");
    await run();
    apply("r2", "0.3.0");
    await run();
    expect(w.installed().version).toBe("0.3.0");
    expect(w.previous()?.version).toBe("0.2.0");
  });

  test("needs seven stable seconds of an active service reporting the new version", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    expect(w.slept).toBe(7);
  });
});

describe("a release it must not trust", () => {
  test("a signature by another key is refused and nothing changes", async () => {
    w.publish({ version: "0.2.0", signWith: "other" });
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("signature"),
    });
    expect(w.installed().version).toBe("0.1.0");
    expect(w.previous()).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  test("a binary that differs from the signed checksum is refused", async () => {
    w.publish({ version: "0.2.0", tamper: true });
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("checksum"),
    });
    expect(w.installed().version).toBe("0.1.0");
  });

  test("a release.json naming another version is refused", async () => {
    w.publish({ version: "0.2.0", manifestVersion: "0.9.9" });
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("0.9.9"),
    });
  });

  test("a version that is not published is refused with the download error", async () => {
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("404"),
    });
    expect(w.installed().version).toBe("0.1.0");
  });

  test("a release whose schema is older than the database is refused", async () => {
    w.publish({ version: "0.0.9", schemaVersion: 3 });
    apply("r1", "0.0.9");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("schema"),
    });
    expect(w.installed().version).toBe("0.1.0");
  });
});

describe("the request file", () => {
  test.each([
    ["not JSON", "{"],
    [
      "a path in place of a version",
      JSON.stringify({ kind: "apply", id: "r1", version: "../../x" }),
    ],
    [
      "a URL",
      JSON.stringify({ kind: "apply", id: "r1", version: "0.2.0", url: "https://evil.test" }),
    ],
    ["an unknown kind", JSON.stringify({ kind: "install", id: "r1" })],
    ["too large", `{"kind":"rollback","id":"r1","pad":"${"x".repeat(5000)}"}`],
  ])("%s is refused and consumed", async (_name, text) => {
    w.rawRequest(text);
    await run();
    expect(w.result()).toMatchObject({ outcome: "refused", requestId: "unknown" });
    expect(existsSync(w.requestPath)).toBe(false);
    expect(w.installed().version).toBe("0.1.0");
    expect(w.calls).toEqual([]);
  });

  test("a link in its place is refused, not followed", async () => {
    writeFileSync(join(w.root, "elsewhere.json"), JSON.stringify({ kind: "rollback", id: "r1" }));
    symlinkSync(join(w.root, "elsewhere.json"), w.requestPath);
    await run();
    expect(w.result()).toMatchObject({ outcome: "refused" });
    expect(existsSync(join(w.root, "elsewhere.json"))).toBe(true);
  });

  test("no request is a no-op", async () => {
    await run();
    expect(w.result()).toBeUndefined();
    expect(w.calls).toEqual([]);
  });
});

describe("idempotence", () => {
  test("a target equal to the installed version touches nothing", async () => {
    apply("r1", "0.1.0");
    await run();
    expect(w.result()).toMatchObject({ outcome: "unchanged", version: "0.1.0" });
    expect(w.previous()).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  test("applying the same version again after an update is a no-op that keeps the previous binary", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    apply("r2", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({ requestId: "r2", outcome: "unchanged" });
    expect(w.previous()?.version).toBe("0.1.0");
    expect(w.calls).toEqual(["restart"]);
  });

  test("a request id already handled is not handled twice", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    w.publish({ version: "0.3.0" });
    apply("r1", "0.3.0");
    await run();
    expect(w.installed().version).toBe("0.2.0");
  });
});

describe("the health gate", () => {
  test("a host that does not stay active is rolled back, with the reason and the version rolled back to", async () => {
    w.publish({ version: "0.2.0", behaviour: "crashes" });
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "reverted",
      version: "0.2.0",
      rolledBackTo: "0.1.0",
      snapshotRestored: false,
      reason: expect.stringContaining("not active"),
    });
    expect(w.installed().version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.1.0");
    expect(w.previous()).toBeUndefined();
  });

  test("a host-info that reports another version fails the gate", async () => {
    w.publish({ version: "0.2.0", behaviour: "reports-old-version" });
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "reverted",
      reason: expect.stringContaining("host-info reports 0.0.1, not 0.2.0"),
    });
    expect(w.installed().version).toBe("0.1.0");
  });

  test("the database snapshot taken for the update is restored, its write-ahead files removed", async () => {
    w.publish({ version: "0.2.0", behaviour: "crashes" });
    w.snapshot("0.2.0", "database as of the drain");
    writeFileSync(join(w.dataRoot, "tomte.db"), "migrated by 0.2.0");
    writeFileSync(join(w.dataRoot, "tomte.db-wal"), "wal");
    writeFileSync(join(w.dataRoot, "tomte.db-shm"), "shm");
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({ outcome: "reverted", snapshotRestored: true });
    expect(w.database).toBe("database as of the drain");
    expect(existsSync(join(w.dataRoot, "tomte.db-wal"))).toBe(false);
    expect(existsSync(join(w.dataRoot, "tomte.db-shm"))).toBe(false);
  });

  test("an old host that does not come back either is reported as failed", async () => {
    w.publish({ version: "0.2.0", behaviour: "crashes" });
    writeFileSync(
      w.bin,
      JSON.stringify({ version: "0.1.0", schemaVersion: 7, behaviour: "crashes" }),
    );
    apply("r1", "0.2.0");
    await run();
    expect(w.result()).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("did not become healthy after the rollback"),
    });
  });
});

describe("a rollback request", () => {
  test("restores the previous binary and keeps no previous afterwards", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    w.request({ kind: "rollback", id: "r2" });
    await run();
    expect(w.result()).toMatchObject({
      requestId: "r2",
      outcome: "rolled-back",
      from: "0.2.0",
      version: "0.1.0",
      snapshotRestored: false,
    });
    expect(w.installed().version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.1.0");
    expect(w.previous()).toBeUndefined();
  });

  test("is refused when no previous version is kept", async () => {
    w.request({ kind: "rollback", id: "r1" });
    await run();
    expect(w.result()).toMatchObject({ outcome: "refused", reason: "no previous version is kept" });
  });

  test("is refused when the previous binary cannot open the database", async () => {
    w.publish({ version: "0.2.0", schemaVersion: 8 });
    apply("r1", "0.2.0");
    await run();
    w.request({ kind: "rollback", id: "r2" });
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("separate, confirmed request"),
    });
    expect(w.installed().version).toBe("0.2.0");
    expect(w.previous()?.version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.2.0");
    expect(w.database).toBe("database of 0.1.0");
  });

  /** 0.2.0 raised the schema (8 over 7) and migrated the database; the snapshot is the 0.1.0-era copy taken at the drain. */
  async function updatedAcrossASchema() {
    w.publish({ version: "0.2.0", schemaVersion: 8 });
    w.snapshot("0.2.0", "database as of the drain");
    w.snapshot("0.9.9", "a snapshot of another update");
    apply("r1", "0.2.0");
    await run();
    writeFileSync(join(w.dataRoot, "tomte.db"), "migrated by 0.2.0");
    writeFileSync(join(w.dataRoot, "tomte.db-wal"), "wal");
  }

  test("a confirmed restore puts the previous binary and the snapshot taken before the update back", async () => {
    await updatedAcrossASchema();
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: true });
    await run();
    expect(w.result()).toMatchObject({
      requestId: "r2",
      outcome: "rolled-back",
      from: "0.2.0",
      version: "0.1.0",
      snapshotRestored: true,
    });
    expect(w.database).toBe("database as of the drain");
    expect(existsSync(join(w.dataRoot, "tomte.db-wal"))).toBe(false);
    expect(w.installed().version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.1.0");
  });

  test("a confirmed restore is refused untouched when the previous binary can open the database as it is", async () => {
    w.publish({ version: "0.2.0" });
    w.snapshot("0.2.0", "database as of the drain");
    apply("r1", "0.2.0");
    await run();
    writeFileSync(join(w.dataRoot, "tomte.db"), "written by 0.2.0");
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: true });
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("would only lose changes"),
    });
    expect(w.database).toBe("written by 0.2.0");
    expect(w.installed().version).toBe("0.2.0");
  });

  test("a confirmed restore without the snapshot of that update is refused untouched, whatever other snapshots exist", async () => {
    await updatedAcrossASchema();
    rmSync(join(w.dataRoot, "updates", "pre-0.2.0.db"));
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: true });
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("pre-0.2.0.db"),
    });
    expect(w.database).toBe("migrated by 0.2.0");
    expect(w.installed().version).toBe("0.2.0");
  });

  test("a snapshot that is a link is not a snapshot", async () => {
    await updatedAcrossASchema();
    const snapshot = join(w.dataRoot, "updates", "pre-0.2.0.db");
    rmSync(snapshot);
    symlinkSync(join(w.dataRoot, "updates", "pre-0.9.9.db"), snapshot);
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: true });
    await run();
    expect(w.result()).toMatchObject({ outcome: "refused" });
    expect(w.database).toBe("migrated by 0.2.0");
  });

  test("a restoreSnapshot that is not exactly true is an invalid request", async () => {
    await updatedAcrossASchema();
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: false } as never);
    await run();
    expect(w.result()).toMatchObject({ outcome: "refused", requestId: "unknown" });
    expect(w.database).toBe("migrated by 0.2.0");
    expect(w.installed().version).toBe("0.2.0");
  });

  test("is refused when the previous binary does not run", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    writeFileSync(`${w.bin}.prev`, "garbage");
    w.request({ kind: "rollback", id: "r2" });
    await run();
    expect(w.result()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("does not run"),
    });
  });
});

describe("a crash after each journal step", () => {
  const STEPS = ["requested", "saving-previous", "swapping", "restarting", "finished"] as const;

  test.each(STEPS)("after %s, the next run completes the update", async (step) => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    w.crashAfter = step;
    await expect(run()).rejects.toThrow(`crash after ${step}`);
    w.crashAfter = undefined;
    await run();
    expect(w.installed().version).toBe("0.2.0");
    expect(w.previous()?.version).toBe("0.1.0");
    expect(w.running?.version).toBe("0.2.0");
    expect(w.result()).toMatchObject({ requestId: "r1", outcome: "updated" });
    expect(existsSync(join(w.stateDir, "journal.json"))).toBe(false);
  });

  test("after the binary was swapped but not journaled, the next run checks it instead of swapping again", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    w.crashAfter = "swapping";
    await expect(run()).rejects.toThrow();
    writeFileSync(w.bin, readFileSync(join(w.releases, "v0.2.0", "tomte-host-linux-x64")));
    w.crashAfter = undefined;
    await run();
    expect(w.previous()?.version).toBe("0.1.0");
    expect(w.result()).toMatchObject({ outcome: "updated" });
  });

  test.each(["rolling-back", "finished"] as const)(
    "of a failed update, after %s, the next run still ends on the old version with the snapshot back",
    async (step) => {
      w.publish({ version: "0.2.0", behaviour: "crashes" });
      w.snapshot("0.2.0", "database as of the drain");
      writeFileSync(join(w.dataRoot, "tomte.db"), "migrated by 0.2.0");
      apply("r1", "0.2.0");
      w.crashAfter = step;
      await expect(run()).rejects.toThrow();
      w.crashAfter = undefined;
      await run();
      expect(w.installed().version).toBe("0.1.0");
      expect(w.running?.version).toBe("0.1.0");
      expect(w.database).toBe("database as of the drain");
      expect(w.result()).toMatchObject({ outcome: "reverted", rolledBackTo: "0.1.0" });
    },
  );

  test("of a rollback request, after rolling-back, the next run finishes the rollback", async () => {
    w.publish({ version: "0.2.0" });
    apply("r1", "0.2.0");
    await run();
    w.request({ kind: "rollback", id: "r2" });
    w.crashAfter = "rolling-back";
    await expect(run()).rejects.toThrow();
    w.crashAfter = undefined;
    await run();
    expect(w.installed().version).toBe("0.1.0");
    expect(w.result()).toMatchObject({ requestId: "r2", outcome: "rolled-back" });
  });

  test("of a confirmed restore, after rolling-back, the next run still ends on the old version with the snapshot back", async () => {
    w.publish({ version: "0.2.0", schemaVersion: 8 });
    w.snapshot("0.2.0", "database as of the drain");
    apply("r1", "0.2.0");
    await run();
    writeFileSync(join(w.dataRoot, "tomte.db"), "migrated by 0.2.0");
    w.request({ kind: "rollback", id: "r2", restoreSnapshot: true });
    w.crashAfter = "rolling-back";
    await expect(run()).rejects.toThrow();
    w.crashAfter = undefined;
    await run();
    expect(w.installed().version).toBe("0.1.0");
    expect(w.database).toBe("database as of the drain");
    expect(w.result()).toMatchObject({
      requestId: "r2",
      outcome: "rolled-back",
      snapshotRestored: true,
    });
  });
});
