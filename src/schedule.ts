import { z } from "zod";
import type { Schedule } from "../web/events.ts";

/** How far back a missed occurrence may lie and still be caught up after downtime. */
export const WINDOW_MS = 12 * 60 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;

const ScheduleInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().trim().min(1), tz: z.string().trim().min(1) }),
  z.object({ kind: z.literal("once"), at: z.number().int() }),
]);

const cronNext = (expr: string, tz: string, after: number): number | null => Bun.cron.parse(expr, after, { tz })?.getTime() ?? null;

/** Validates untrusted input into a schedule that fires at least once and no more often than every 5 minutes. */
export function parseSchedule(input: unknown): Schedule {
  const s = ScheduleInput.parse(input);
  const now = Date.now();
  if (s.kind === "once") {
    if (s.at <= now) throw new Error("time is in the past");
    return s;
  }
  let first: number | null;
  try {
    first = cronNext(s.expr, s.tz, now);
  } catch {
    throw new Error("invalid cron or time zone");
  }
  if (first === null) throw new Error("schedule never fires");
  let prev = first;
  for (let i = 1; i < 50; i++) {
    const next = cronNext(s.expr, s.tz, prev);
    if (next === null) break;
    if (next - prev < MIN_INTERVAL_MS) throw new Error("minimum interval is 5 minutes");
    prev = next;
  }
  return s;
}

/** First occurrence strictly after `after`. */
export function nextOccurrence(s: Schedule, after: number): number | null {
  if (s.kind === "once") return s.at > after ? s.at : null;
  return cronNext(s.expr, s.tz, after);
}

/**
 * Latest occurrence `t` with `after < t <= notAfter`. For cron the walk starts no earlier than
 * one window before `notAfter`, so older occurrences are not seen.
 */
export function latestOccurrence(s: Schedule, after: number, notAfter: number): number | null {
  if (s.kind === "once") return s.at > after && s.at <= notAfter ? s.at : null;
  let cursor = Math.max(after, notAfter - WINDOW_MS - 60_000);
  let latest: number | null = null;
  for (;;) {
    const t = cronNext(s.expr, s.tz, cursor);
    if (t === null || t > notAfter) return latest;
    latest = cursor = t;
  }
}

/** Whether any occurrence `t` satisfies `after < t <= before`. */
export function hasOccurrence(s: Schedule, after: number, before: number): boolean {
  const t = nextOccurrence(s, after);
  return t !== null && t <= before;
}

export function nextOccurrences(s: Schedule, from: number, n: number): number[] {
  const out: number[] = [];
  for (let t = nextOccurrence(s, from); t !== null && out.length < n; t = nextOccurrence(s, t)) out.push(t);
  return out;
}
