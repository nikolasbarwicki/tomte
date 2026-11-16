import type { Database } from "bun:sqlite";

import { createPresenceStore } from "./store.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long before the pause the owner is warned. */
const WARN_DAYS = 2;

/** One stretch of absence: it begins at the owner's last action and ends with the next. */
interface Absence {
  /** The time of the owner's last action; the same for every check of one absence, so it can key what is raised for it. */
  since: number;
  /** The setting that decides when the absence pauses routines. */
  pauseAfterDays: number;
}

export interface PresenceOptions {
  db: Database;
  /** Days without the owner after which `pause` runs; 0 turns the check off. */
  pauseAfterDays: number;
  /** The clock, in epoch milliseconds; the system clock when omitted. */
  now?: () => number;
  /** The owner is 2 days from the pause. True when someone was told; false leaves the absence unwarned, so a later check tries again. */
  warn(absence: Absence): boolean;
  /** The owner has been away for `pauseAfterDays`. Called by every check from then on, so it must change nothing the second time. */
  pause(absence: Absence): void;
  /** The owner did something after a gap: undo what the absence did. */
  returned(): void;
}

export interface Presence {
  /**
   * The owner did something (any request from a paired device except the event stream; a channel's message or button).
   * At most one write a minute; one that is written ends the absence.
   */
  touch(at?: number): void;
  /** Warns 2 days before the pause (once per absence) and, past `pauseAfterDays`, pauses. Does nothing when the setting is 0. */
  check(): void;
}

/**
 * The owner's presence: the time of their last action, kept in the database so a restart does not reset it. Features tell it what
 * counts as an action (`touch`) and what an absence does (`warn`, `pause`, `returned`); it knows nothing of routines or channels.
 */
export function createPresence(o: PresenceOptions): Presence {
  const store = createPresenceStore(o.db);
  const now = o.now ?? Date.now;

  /** The time of the last action. With no row yet, now is written: turning the setting on never pauses at once. */
  function lastActionAt(): number {
    const row = store.get();
    if (row) return row.lastActionAt;
    const t = now();
    store.act(t);
    return t;
  }

  return {
    touch(at = now()) {
      const row = store.get();
      if (row && at >= row.lastActionAt && at - row.lastActionAt < MINUTE_MS) return;
      store.act(at);
      if (row) o.returned();
    },

    check() {
      if (o.pauseAfterDays <= 0) return;
      const since = lastActionAt();
      const absence = { since, pauseAfterDays: o.pauseAfterDays };
      const away = now() - since;
      if (away >= o.pauseAfterDays * DAY_MS) return o.pause(absence);
      if (o.pauseAfterDays <= WARN_DAYS || away < (o.pauseAfterDays - WARN_DAYS) * DAY_MS) return;
      if (store.get()?.lastWarnedAt != null) return;
      if (o.warn(absence)) store.warned(now());
    },
  };
}
