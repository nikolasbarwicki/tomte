import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  schedule TEXT NOT NULL,              -- JSON Schedule
  active INTEGER NOT NULL DEFAULT 1,
  catch_up INTEGER NOT NULL DEFAULT 1,
  last_scheduled_for INTEGER,          -- epoch ms of the last occurrence claimed (fired, caught up, or recorded missed)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_bot ON routines(bot_id);
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  scheduled_for INTEGER,               -- NULL for manual runs
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted','skipped')),
  session_id TEXT,
  output TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (routine_id, scheduled_for)   -- NULLs do not collide, so manual runs are unlimited
);
CREATE INDEX IF NOT EXISTS routine_runs_by_routine ON routine_runs(routine_id, started_at DESC);
`;

/** Applies pending schema versions, tracked in `PRAGMA user_version`. */
export function migrate(db: Database): Database {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  if (user_version < 1)
    db.transaction(() => {
      db.run(SCHEMA_V1);
      db.run("PRAGMA user_version = 1");
    })();
  return db;
}

export function openDb(cwd: string): Database {
  mkdirSync(join(cwd, ".host"), { recursive: true });
  return migrate(new Database(join(cwd, ".host", "claudebot.db"), { create: true }));
}
