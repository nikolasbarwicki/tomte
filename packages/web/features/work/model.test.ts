import { expect, test } from "bun:test";

import type { FeatureStatus, WorkSource } from "@claudebot/contract/events";

import { sortSources } from "./model.ts";

const source = (status: FeatureStatus, lastEventAt = 1): WorkSource => ({
  id: status,
  label: status,
  status,
  lastEventAt,
  work: null,
  events: [],
});

test("sources that need the user come first: a question, then a blocked report, then a failure", () => {
  const sorted = sortSources([
    source("done"),
    source("failed"),
    source("running"),
    source("blocked"),
    source("stopped"),
    source("needs_you"),
  ]);
  expect(sorted.map((s) => s.status)).toEqual([
    "needs_you",
    "blocked",
    "failed",
    "running",
    "stopped",
    "done",
  ]);
});

test("within one status the source heard from most recently comes first", () => {
  const sorted = sortSources([
    { ...source("blocked", 1), id: "old" },
    { ...source("blocked", 5), id: "new" },
  ]);
  expect(sorted.map((s) => s.id)).toEqual(["new", "old"]);
});
