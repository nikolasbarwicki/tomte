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

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS bot_activity (
  bot_id TEXT PRIMARY KEY,
  last_from TEXT CHECK (last_from IN ('user','bot')),
  last_text TEXT,                      -- newest chat message shown in the transcript, whitespace collapsed
  last_at INTEGER,
  seen_at INTEGER NOT NULL DEFAULT 0   -- when the user last had this bot's chat on screen
);
`;

/** Applies pending schema versions, tracked in `PRAGMA user_version`. */
export function migrate(db: Database): Database {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  const migrations = [SCHEMA_V1, SCHEMA_V2];
  for (const [i, schema] of migrations.entries()) {
    if (user_version > i) continue;
    db.transaction(() => {
      db.run(schema);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

export function openDb(cwd: string): Database {
  mkdirSync(join(cwd, ".host"), { recursive: true });
  return migrate(new Database(join(cwd, ".host", "claudebot.db"), { create: true }));
}
