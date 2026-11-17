import { expect, test } from "bun:test";

import { rateLimitRows } from "./rate-limits.ts";

test("rows put a rejected window first, then a warned one, then the most used, with whole percents kept in range", () => {
  const rows = rateLimitRows({
    five_hour: { type: "rate_limit", status: "allowed", window: "five_hour", utilization: 0.62 },
    seven_day: {
      type: "rate_limit",
      status: "allowed_warning",
      window: "seven_day",
      utilization: 0.8,
      resetsAt: 5,
    },
    seven_day_opus: {
      type: "rate_limit",
      status: "rejected",
      window: "seven_day_opus",
      utilization: 1.2,
    },
    "": { type: "rate_limit", status: "allowed" },
  });
  expect(rows.map((r) => [r.label, r.percent, r.status])).toEqual([
    ["Weekly Opus limit", 100, "rejected"],
    ["Weekly limit", 80, "allowed_warning"],
    ["Session limit", 62, "allowed"],
    ["Usage limit", undefined, "allowed"],
  ]);
  expect(rows[1]?.resetsAt).toBe(5);
});

test("a window the app does not know by name is shown by the CLI's own name", () => {
  const [row] = rateLimitRows({
    new_window: { type: "rate_limit", status: "allowed", window: "new_window" },
  });
  expect(row?.label).toBe("new window");
});
