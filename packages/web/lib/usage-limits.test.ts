import { expect, test } from "bun:test";

import { untilReset } from "./usage-limits.ts";

test("the time until a reset is in the largest two units, and now once it passed", () => {
  const now = 1_000_000_000_000;
  expect(untilReset(now - 1, now)).toBe("now");
  expect(untilReset(now + 45 * 60_000, now)).toBe("45m");
  expect(untilReset(now + 125 * 60_000, now)).toBe("2h 5m");
  expect(untilReset(now + (3 * 24 + 4) * 3_600_000, now)).toBe("3d 4h");
});
