import { expect, test } from "bun:test";

import { restoreWarning, updateLine } from "./update-line.ts";

const NOW = 1_800_000_000_000;

test("each update status reads as one headline and one line", () => {
  expect(updateLine({ status: "bundled" }).title).toBe("Updated with the app");
  expect(
    updateLine({ status: "unmanaged", reason: "this host has no update helper installed" }),
  ).toEqual({
    title: "Can't update from here",
    detail: "This host has no update helper installed.",
  });
  expect(updateLine(undefined)).toEqual({ title: "…", detail: "" });
});

test("a host whose feed has not answered is checking, not up to date", () => {
  expect(updateLine({ status: "current", checkedAt: 0 }, NOW).title).toBe("Checking for updates…");
  expect(updateLine({ status: "current", checkedAt: NOW - 5 * 3_600_000 }, NOW)).toEqual({
    title: "Up to date",
    detail: "Checked 5 h ago.",
  });
  expect(updateLine({ status: "current", checkedAt: NOW - 20_000 }, NOW).detail).toBe(
    "Checked just now.",
  );
});

test("the release a host rolled back from is said to be skipped, with its notes", () => {
  const skipped = {
    version: "0.4.2",
    notesUrl: "https://github.com/owner/tomte/releases/tag/v0.4.2",
    raisesShellApi: false,
  };
  const line = updateLine({ status: "current", checkedAt: NOW - 20_000, skipped }, NOW);
  expect(line.title).toBe("Up to date");
  expect(line.detail).toBe(
    "Checked just now. 0.4.2 is skipped because you rolled back from it: it is not offered or installed automatically until a newer release is out.",
  );
  expect(line.notesUrl).toBe(skipped.notesUrl);
  expect(
    updateLine(
      { status: "current", checkedAt: NOW, skipped: { ...skipped, raisesShellApi: true } },
      NOW,
    ).detail,
  ).toContain("update the app as well");
});

test("a newer release names its version and links its notes, and warns when it raises the shell API", () => {
  const notesUrl = "https://github.com/owner/tomte/releases/tag/v0.4.2";
  const plain = updateLine({
    status: "available",
    version: "0.4.2",
    notesUrl,
    raisesShellApi: false,
  });
  expect(plain).toMatchObject({ title: "0.4.2 available", notesUrl });
  const raising = updateLine({
    status: "available",
    version: "0.4.2",
    notesUrl,
    raisesShellApi: true,
  });
  expect(raising.detail).toContain("update the app as well");
});

test("only a web address becomes a link", () => {
  const line = updateLine({
    status: "available",
    version: "0.4.2",
    notesUrl: "javascript:alert(1)",
    raisesShellApi: false,
  });
  expect(line.notesUrl).toBeUndefined();
});

test("a drain says what it waits for, how long it has gone on, and a failure says why", () => {
  const drain = {
    status: "draining",
    version: "0.4.2",
    running: 2,
    since: 1,
    overdue: false,
  } as const;
  expect(updateLine(drain)).toEqual({
    title: "Updating to 0.4.2 when idle",
    detail: "Waiting for 2 things to finish. New messages are refused until the update is done.",
  });
  expect(updateLine({ ...drain, running: 1 }).detail).toContain("Waiting for 1 thing to finish");
  expect(updateLine({ ...drain, running: 0 }).detail).toContain("Nothing is running.");
  expect(updateLine({ ...drain, overdue: true }).detail).toContain(
    "longer than 30 minutes; Update now stops whatever is still running",
  );
  expect(updateLine({ status: "applying", version: "0.4.2" }).title).toBe("Updating to 0.4.2…");
  expect(
    updateLine({
      status: "failed",
      version: "0.4.2",
      reason: "the new host never answered",
      rolledBackTo: "0.4.1",
    }),
  ).toEqual({
    title: "Update to 0.4.2 failed, rolled back to 0.4.1.",
    detail: "The new host never answered.",
  });
});

test("a rollback reads as a rollback while it waits, runs and fails", () => {
  const drain = {
    status: "draining",
    version: "0.4.1",
    running: 1,
    since: 1,
    overdue: true,
    rollback: true,
  } as const;
  expect(updateLine(drain)).toEqual({
    title: "Rolling back to 0.4.1 when idle",
    detail:
      "Waiting for 1 thing to finish. New messages are refused until the rollback is done. This is taking longer than 30 minutes; Roll back now stops whatever is still running.",
  });
  expect(updateLine({ status: "applying", version: "0.4.1", rollback: true }).title).toBe(
    "Rolling back to 0.4.1…",
  );
  expect(
    updateLine({
      status: "failed",
      version: "0.4.1",
      reason: "no previous version is kept",
      rollback: true,
    }),
  ).toEqual({ title: "Rollback to 0.4.1 failed.", detail: "No previous version is kept." });
});

test("restoring the database says which copy goes back and that everything since is lost", () => {
  const snapshotAt = Date.UTC(2026, 10, 18, 9, 30);
  const text = restoreWarning({ version: "0.4.1", snapshotAt });
  expect(text).toContain("0.4.1 cannot open the database");
  expect(text).toContain(new Date(snapshotAt).toLocaleString());
  expect(text).toContain("Everything that changed since is lost");
});
