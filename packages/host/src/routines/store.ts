import type { Database } from "bun:sqlite";

import {
  Schedule,
  type RoutineRun,
  type RunStatus,
  type RunTrigger,
} from "@claudebot/contract/events";

/** A routine as stored; `Routine` adds the fields derived at read time. */
export type RoutineRecord = {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  schedule: Schedule;
  active: boolean;
  catchUp: boolean;
  notifyResult: boolean;
  lastScheduledFor: number | null;
  createdAt: number;
  updatedAt: number;
};

type RoutineRow = {
  id: string;
  bot_id: string;
  name: string;
  instruction: string;
  schedule: string;
  active: number;
  catch_up: number;
  notify_result: number;
  last_scheduled_for: number | null;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  id: string;
  routine_id: string;
  trigger: RunTrigger;
  scheduled_for: number | null;
  status: RunStatus;
  session_id: string | null;
  output: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

const toRoutine = (r: RoutineRow): RoutineRecord => ({
  id: r.id,
  botId: r.bot_id,
  name: r.name,
  instruction: r.instruction,
  schedule: Schedule.parse(JSON.parse(r.schedule)),
  active: !!r.active,
  catchUp: !!r.catch_up,
  notifyResult: !!r.notify_result,
  lastScheduledFor: r.last_scheduled_for,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): RoutineRun => ({
  id: r.id,
  routineId: r.routine_id,
  trigger: r.trigger,
  scheduledFor: r.scheduled_for,
  status: r.status,
  sessionId: r.session_id,
  output: r.output,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function getRoutine(db: Database, id: string): RoutineRecord | undefined {
  const r = db.query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?").get(id);
  return r ? toRoutine(r) : undefined;
}

export function listRoutines(db: Database, botId: string): RoutineRecord[] {
  return db
    .query<RoutineRow, [string]>("SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at")
    .all(botId)
    .map(toRoutine);
}

export function listActiveRoutines(db: Database): RoutineRecord[] {
  return db.query<RoutineRow, []>("SELECT * FROM routines WHERE active = 1").all().map(toRoutine);
}

export function insertRoutine(db: Database, r: RoutineRecord) {
  db.query(
    `INSERT INTO routines (id, bot_id, name, instruction, schedule, active, catch_up, notify_result, last_scheduled_for, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.botId,
    r.name,
    r.instruction,
    JSON.stringify(r.schedule),
    +r.active,
    +r.catchUp,
    +r.notifyResult,
    r.lastScheduledFor,
    r.createdAt,
    r.updatedAt,
  );
}

/** Overwrites the editable fields and `last_scheduled_for` of an existing routine. */
export function saveRoutine(db: Database, r: RoutineRecord) {
  db.query(
    `UPDATE routines SET name = ?, instruction = ?, schedule = ?, active = ?, catch_up = ?, notify_result = ?, last_scheduled_for = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    r.name,
    r.instruction,
    JSON.stringify(r.schedule),
    +r.active,
    +r.catchUp,
    +r.notifyResult,
    r.lastScheduledFor,
    r.updatedAt,
    r.id,
  );
}

export function deleteRoutine(db: Database, id: string) {
  db.query("DELETE FROM routines WHERE id = ?").run(id);
}

/** Claims occurrence `t` unless it or a later one is already claimed; false when another path got there first. */
export function claimOccurrence(db: Database, id: string, t: number): boolean {
  return (
    db
      .query(
        "UPDATE routines SET last_scheduled_for = ? WHERE id = ? AND (last_scheduled_for IS NULL OR last_scheduled_for < ?)",
      )
      .run(t, id, t).changes > 0
  );
}

export function deactivateRoutine(db: Database, id: string, now: number) {
  db.query("UPDATE routines SET active = 0, updated_at = ? WHERE id = ?").run(now, id);
}

export function insertRun(db: Database, r: RoutineRun) {
  db.query(
    `INSERT INTO routine_runs (id, routine_id, trigger, scheduled_for, status, session_id, output, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.routineId,
    r.trigger,
    r.scheduledFor,
    r.status,
    r.sessionId,
    r.output,
    r.error,
    r.startedAt,
    r.finishedAt,
  );
}

/** Ends a run that has not ended; false when it already had (a deleted run, or one another path finished first). */
export function finishRun(
  db: Database,
  id: string,
  status: Exclude<RunStatus, "running" | "waiting">,
  fields: { output?: string; error?: string; finishedAt: number },
): boolean {
  return (
    db
      .query(
        "UPDATE routine_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ? AND status IN ('running', 'waiting')",
      )
      .run(status, fields.output ?? null, fields.error ?? null, fields.finishedAt, id).changes > 0
  );
}

export function getRun(db: Database, id: string): RoutineRun | undefined {
  const r = db.query<RunRow, [string]>("SELECT * FROM routine_runs WHERE id = ?").get(id);
  return r ? toRun(r) : undefined;
}

/** A running run whose turn ended on a request to the owner becomes `waiting`; false when it was not running. */
export function parkRun(db: Database, id: string): boolean {
  return (
    db
      .query("UPDATE routine_runs SET status = 'waiting' WHERE id = ? AND status = 'running'")
      .run(id).changes > 0
  );
}

/** A waiting run runs again; false when it was not waiting. */
export function unparkRun(db: Database, id: string): boolean {
  return (
    db
      .query("UPDATE routine_runs SET status = 'running' WHERE id = ? AND status = 'waiting'")
      .run(id).changes > 0
  );
}

/** The routine's run that waits for its owner, if any; a routine has at most one run in flight. */
export function waitingRun(db: Database, routineId: string): RoutineRun | null {
  const r = db
    .query<RunRow, [string]>(
      "SELECT * FROM routine_runs WHERE routine_id = ? AND status = 'waiting' ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(routineId);
  return r ? toRun(r) : null;
}

/** Every run of the bot's routines that waits for its owner. */
export function waitingRunsOfBot(db: Database, botId: string): RoutineRun[] {
  return db
    .query<RunRow, [string]>(
      `SELECT routine_runs.* FROM routine_runs JOIN routines ON routines.id = routine_runs.routine_id
       WHERE routines.bot_id = ? AND routine_runs.status = 'waiting' ORDER BY routine_runs.started_at, routine_runs.rowid`,
    )
    .all(botId)
    .map(toRun);
}

/** Ids of the routine's runs that have not ended: running or waiting. */
export function unfinishedRunIds(db: Database, routineId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM routine_runs WHERE routine_id = ? AND status IN ('running', 'waiting')",
    )
    .all(routineId)
    .map((r) => r.id);
}

export function lastRun(db: Database, routineId: string): RoutineRun | null {
  const r = db
    .query<RunRow, [string]>(
      "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(routineId);
  return r ? toRun(r) : null;
}

/** Newest first; `before` pages by `started_at`. */
export function listRuns(
  db: Database,
  routineId: string,
  before: number,
  limit: number,
): RoutineRun[] {
  return db
    .query<RunRow, [string, number, number]>(
      "SELECT * FROM routine_runs WHERE routine_id = ? AND started_at < ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
    )
    .all(routineId, before, limit)
    .map(toRun);
}

/** Marks runs left `running` by a previous process as interrupted, and returns them as they now stand; `live` lists run ids this process still owns. A `waiting` run has no process and is left alone. */
export function interruptStaleRuns(db: Database, now: number, live: string[]): RoutineRun[] {
  return db
    .query<RunRow, [number, string]>(
      "UPDATE routine_runs SET status = 'interrupted', error = 'app stopped during run', finished_at = ? WHERE status = 'running' AND id NOT IN (SELECT value FROM json_each(?)) RETURNING *",
    )
    .all(now, JSON.stringify(live))
    .map(toRun);
}
