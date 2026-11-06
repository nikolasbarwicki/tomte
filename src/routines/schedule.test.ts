import { describe, expect, test } from "bun:test";
import { WINDOW_MS, hasOccurrence, latestOccurrence, nextOccurrences, parseSchedule } from "./schedule.ts";
import type { Schedule } from "../contract/events.ts";

const at = (iso: string) => Date.parse(iso);
const hourly: Schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC" };
const dailyMidnight: Schedule = { kind: "cron", expr: "0 0 * * *", tz: "UTC" };

describe("latestOccurrence", () => {
  test("returns the latest occurrence at or before notAfter", () => {
    expect(latestOccurrence(hourly, 0, at("2026-01-01T10:30:00Z"))).toBe(at("2026-01-01T10:00:00Z"));
    expect(latestOccurrence(hourly, 0, at("2026-01-01T10:00:00Z"))).toBe(at("2026-01-01T10:00:00Z"));
  });

  test("excludes occurrences at or before `after`", () => {
    expect(latestOccurrence(hourly, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:59:00Z"))).toBeNull();
  });

  test("does not look further back than the window, however old `after` is", () => {
    expect(latestOccurrence(dailyMidnight, 0, at("2026-01-01T11:00:00Z"))).toBe(at("2026-01-01T00:00:00Z"));
    expect(latestOccurrence(dailyMidnight, 0, at("2026-01-01T13:00:00Z"))).toBeNull();
    expect(hasOccurrence(dailyMidnight, 0, at("2026-01-01T13:00:00Z") - WINDOW_MS)).toBe(true);
  });
});

test("weekday cron in Europe/Warsaw keeps 09:00 local across the 2026-03-29 DST jump", () => {
  const s: Schedule = { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Warsaw" };
  expect(nextOccurrences(s, at("2026-03-26T12:00:00Z"), 3)).toEqual([
    at("2026-03-27T08:00:00Z"),
    at("2026-03-30T07:00:00Z"),
    at("2026-03-31T07:00:00Z"),
  ]);
});

describe("parseSchedule", () => {
  test("rejects a one-shot in the past", () => {
    expect(() => parseSchedule({ kind: "once", at: Date.now() - 1000 })).toThrow("time is in the past");
  });

  test("rejects intervals under 5 minutes", () => {
    expect(() => parseSchedule({ kind: "cron", expr: "*/2 * * * *", tz: "UTC" })).toThrow("minimum interval is 5 minutes");
    expect(() => parseSchedule({ kind: "cron", expr: "0,1 9 * * *", tz: "UTC" })).toThrow("minimum interval is 5 minutes");
    expect(parseSchedule({ kind: "cron", expr: "*/5 * * * *", tz: "UTC" })).toEqual({ kind: "cron", expr: "*/5 * * * *", tz: "UTC" });
  });

  test("rejects a cron with no future match", () => {
    expect(() => parseSchedule({ kind: "cron", expr: "0 0 30 2 *", tz: "UTC" })).toThrow("schedule never fires");
  });

  test("rejects an invalid expression or zone", () => {
    expect(() => parseSchedule({ kind: "cron", expr: "nope", tz: "UTC" })).toThrow("invalid cron or time zone");
    expect(() => parseSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" })).toThrow("invalid cron or time zone");
  });
});
