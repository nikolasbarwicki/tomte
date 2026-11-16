import { expect, test } from "bun:test";

import { describeCap, startRunClock } from "./run-clock.ts";

// The clock measures real elapsed time, so these tests wait a few multiples of a tiny cap: a fake timer would not exercise it.
const CAP = 30;

test("a clock fires once when the cap of active time has passed", async () => {
  let fired = 0;
  startRunClock(CAP, () => fired++);
  await Bun.sleep(CAP * 4);
  expect(fired).toBe(1);
});

test("a clock paused for longer than the cap does not expire, and counts only the active time when resumed", async () => {
  let fired = 0;
  const clock = startRunClock(CAP * 2, () => fired++);
  await Bun.sleep(CAP);
  clock.pause();
  await Bun.sleep(CAP * 6);
  expect(fired).toBe(0);
  clock.resume();
  await Bun.sleep(CAP * 3);
  expect(fired).toBe(1);
  clock.clear();
});

test("a cleared clock never fires, and pausing or resuming it afterwards does nothing", async () => {
  let fired = 0;
  const clock = startRunClock(CAP, () => fired++);
  clock.clear();
  clock.resume();
  clock.pause();
  clock.resume();
  await Bun.sleep(CAP * 4);
  expect(fired).toBe(0);
});

test("pausing or resuming twice is the same as once", async () => {
  let fired = 0;
  const clock = startRunClock(CAP, () => fired++);
  clock.resume();
  clock.pause();
  clock.pause();
  await Bun.sleep(CAP * 3);
  expect(fired).toBe(0);
  clock.resume();
  clock.resume();
  await Bun.sleep(CAP * 4);
  expect(fired).toBe(1);
});

test("the cap reads in minutes when it is whole minutes", () => {
  expect(describeCap(30 * 60_000)).toBe("30 minutes");
  expect(describeCap(60_000)).toBe("1 minute");
  expect(describeCap(2000)).toBe("2 seconds");
  expect(describeCap(40)).toBe("40 ms");
});
