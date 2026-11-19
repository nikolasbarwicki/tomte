import { describe, expect, test } from "bun:test";

import {
  needsYou,
  problemsOf,
  updateFailedText,
  type ClaudeStatus,
  type HostStatus,
  type UpdateStatus,
} from "./host-status.ts";

const claude = (state: ClaudeStatus["state"]): ClaudeStatus => ({
  state,
  ignoredEnv: [],
  checkedAt: 1,
});
const calm: UpdateStatus = { status: "unmanaged", reason: "none" };
const status = (state: ClaudeStatus["state"]): HostStatus => ({
  version: "1.0.0",
  mode: "remote",
  claude: claude(state),
  update: calm,
  autoUpdate: false,
  problems: problemsOf(claude(state), calm),
});
const bot = (needsYou: number) => ({ needsYou });

describe("problemsOf", () => {
  test("a signed-out host has one problem, a signed-in or unknown one has none", () => {
    expect(problemsOf(claude("signed-out"), calm)).toEqual([{ kind: "claude-signed-out" }]);
    expect(problemsOf(claude("signed-in"), calm)).toEqual([]);
    expect(problemsOf(claude("unknown"), calm)).toEqual([]);
  });

  test("a failed update is a problem that names the version and what was put back; no other update state is one", () => {
    const failed: UpdateStatus = {
      status: "failed",
      version: "0.4.2",
      reason: "the health gate failed",
      rolledBackTo: "0.4.1",
    };
    expect(problemsOf(claude("signed-in"), failed)).toEqual([
      { kind: "update-failed", version: "0.4.2", rolledBackTo: "0.4.1" },
    ]);
    expect(
      problemsOf(claude("signed-out"), { status: "failed", version: "0.4.2", reason: "x" }),
    ).toHaveLength(2);
    for (const update of [
      calm,
      { status: "current", checkedAt: 1 },
      { status: "draining", version: "0.4.2", running: 1, since: 1, overdue: true },
      { status: "applying", version: "0.4.2" },
    ] satisfies UpdateStatus[])
      expect(problemsOf(claude("signed-in"), update)).toEqual([]);
  });

  test("the failed update's wording says what was rolled back to only when something was", () => {
    expect(updateFailedText({ version: "0.4.2", rolledBackTo: "0.4.1" })).toBe(
      "Update to 0.4.2 failed, rolled back to 0.4.1",
    );
    expect(updateFailedText({ version: "0.4.2" })).toBe("Update to 0.4.2 failed");
  });

  test("a failed rollback is its own problem, worded as a rollback", () => {
    const failed: UpdateStatus = {
      status: "failed",
      version: "0.4.1",
      reason: "no previous version is kept",
      rollback: true,
    };
    expect(problemsOf(claude("signed-in"), failed)).toEqual([
      { kind: "update-failed", version: "0.4.1", rollback: true },
    ]);
    expect(updateFailedText({ version: "0.4.1", rollback: true })).toBe("Rollback to 0.4.1 failed");
  });
});

describe("needsYou", () => {
  test("counts the bots' items plus the host's problems", () => {
    expect(needsYou([bot(2), bot(1)], status("signed-out"))).toBe(4);
    expect(needsYou([bot(2), bot(1)], status("signed-in"))).toBe(3);
  });

  test("a host with no bots, or no status yet, still counts what it knows", () => {
    expect(needsYou([], status("signed-out"))).toBe(1);
    expect(needsYou([bot(2)], undefined)).toBe(2);
    expect(needsYou([], undefined)).toBe(0);
  });
});
