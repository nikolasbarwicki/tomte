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

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  catalog_id TEXT,                     -- NULL for custom servers
  name TEXT NOT NULL UNIQUE,           -- the MCP server name: mcp__<name>__<tool>
  transport TEXT NOT NULL,             -- JSON Transport, never a secret
  auth TEXT NOT NULL,                  -- JSON Auth, never a secret
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('disconnected','connected','needs-auth','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_tools (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  read_only INTEGER NOT NULL,
  destructive INTEGER NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('off','ask','auto')),
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (integration_id, tool_name)
);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS integration_skills (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, skill_name)
);
`;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS credential_entries (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sign_in_url TEXT NOT NULL,
  origin TEXT NOT NULL,                -- derived from sign_in_url
  username TEXT NOT NULL,              -- the password lives only in the OS keychain
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credential_grants (
  bot_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES credential_entries(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, entry_id)
);
`;

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted','working','input-required','completed','failed','canceled')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_requester ON handoffs(requester_id);
CREATE INDEX IF NOT EXISTS handoffs_assignee ON handoffs(assignee_id);
CREATE TABLE IF NOT EXISTS handoff_messages (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('brief','message','result','failure','cancel')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handoff_messages_by_handoff ON handoff_messages(handoff_id, created_at);
`;

/** Applies pending schema versions, tracked in `PRAGMA user_version`. */
export function migrate(db: Database): Database {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  const migrations = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6];
  for (const [i, schema] of migrations.entries()) {
    if (user_version > i) continue;
    db.transaction(() => {
      db.run(schema);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

/** Opens the database in the data root, creating the directory and the file on first run. */
export function openDb(dataRoot: string): Database {
  mkdirSync(dataRoot, { recursive: true });
  return migrate(new Database(join(dataRoot, "claudebot.db"), { create: true }));
}
