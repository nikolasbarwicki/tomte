import { expect, test } from "bun:test";

import { rateLimitRows, untilReset } from "./rate-limits.ts";

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
    ["5-hour limit", 62, "allowed"],
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

test("the time until a reset is in the largest two units, and now once it passed", () => {
  const now = 1_000_000_000_000;
  expect(untilReset(now - 1, now)).toBe("now");
  expect(untilReset(now + 45 * 60_000, now)).toBe("45m");
  expect(untilReset(now + 125 * 60_000, now)).toBe("2h 5m");
  expect(untilReset(now + (3 * 24 + 4) * 3_600_000, now)).toBe("3d 4h");
});
