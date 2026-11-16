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

const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_digest BLOB NOT NULL,          -- SHA-256 of the device token; the token itself is never stored
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_digest BLOB PRIMARY KEY,        -- SHA-256 of the normalized code
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

const SCHEMA_V8 = `
CREATE TABLE IF NOT EXISTS pairing_failures (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- one row: failed exchanges since a pairing code was last created
  failures INTEGER NOT NULL
);
`;

const SCHEMA_V9 = `
ALTER TABLE devices ADD COLUMN launch INTEGER NOT NULL DEFAULT 0;  -- 1 for the device a desktop sidecar's launch token registered; never inferred from the name
CREATE UNIQUE INDEX devices_one_launch ON devices(launch) WHERE launch = 1;
`;

const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS event_sources (
  bot_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  label TEXT NOT NULL,
  work TEXT,                           -- JSON WorkSnapshot; each event that carries one replaces it
  last_event_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, source_id)
);
CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,                   -- the sender's dedupe key
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','failed','done','stopped','progress')),
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,                        -- JSON array of suggested answers; questions only
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','acted','dismissed','resolved','info')),
  UNIQUE (bot_id, key)
);
CREATE INDEX IF NOT EXISTS external_events_by_source ON external_events(bot_id, source_id, received_at);
`;

// The sidebar counts open items on every bots broadcast; this index holds only those rows.
const SCHEMA_V11 = `
CREATE INDEX IF NOT EXISTS external_events_open ON external_events(bot_id) WHERE state = 'open';
`;

// `blocked` joins the kinds of external event. SQLite cannot change a CHECK, so the table is rebuilt with its rows and
// rowids (arrival order) kept; the indexes went with the old table and are made again.
const SCHEMA_V12 = `
CREATE TABLE external_events_v12 (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,                   -- the sender's dedupe key
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','blocked','failed','done','stopped','progress')),
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,                        -- JSON array of suggested answers; questions only
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','acted','dismissed','resolved','info')),
  UNIQUE (bot_id, key)
);
INSERT INTO external_events_v12 (rowid, id, bot_id, key, source_id, kind, title, body, options, received_at, state)
  SELECT rowid, id, bot_id, key, source_id, kind, title, body, options, received_at, state FROM external_events ORDER BY rowid;
DROP TABLE external_events;
ALTER TABLE external_events_v12 RENAME TO external_events;
CREATE INDEX external_events_by_source ON external_events(bot_id, source_id, received_at);
CREATE INDEX external_events_open ON external_events(bot_id) WHERE state = 'open';
`;

// An answer's relay (ADR-0008): where it goes, the sender's question id and the relay's state, kept on the event so that
// once-only survives retries and restarts. `relay_answer` is the accepted answer text, kept until a retry might need it.
const SCHEMA_V13 = `
ALTER TABLE external_events ADD COLUMN question_id TEXT;
ALTER TABLE external_events ADD COLUMN reply TEXT;                 -- JSON ReplyTarget
ALTER TABLE external_events ADD COLUMN relay_state TEXT NOT NULL DEFAULT 'none' CHECK (relay_state IN ('none','pending','relayed','failed'));
ALTER TABLE external_events ADD COLUMN relay_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE external_events ADD COLUMN relay_error TEXT;
ALTER TABLE external_events ADD COLUMN relay_answer TEXT;
`;

// The double-loop chat mode's task log (ADR-0011), keyed by bot and Claude Code session. `loop_tasks` holds each background
// task's current state; `loop_events` is the append-only log beside it: progress and findings, activity, steers and the reports
// that never enter the front's CLI session, so a transcript replay reads them from here.
const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS loop_tasks (
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,               -- the id Claude Code gives the background agent
  agent_type TEXT,
  model TEXT,
  effort TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','interrupted','done','failed','cancelled')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (bot_id, session_id, task_id)
);
CREATE INDEX IF NOT EXISTS loop_tasks_active ON loop_tasks(bot_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress','activity','steer','report')),
  data TEXT NOT NULL                   -- JSON; the shape depends on kind
);
CREATE INDEX IF NOT EXISTS loop_events_by_session ON loop_events(bot_id, session_id, at);
CREATE INDEX IF NOT EXISTS loop_events_by_task ON loop_events(bot_id, session_id, task_id, kind);
`;

/** A queued task's `after_task` is the task it waits for, null for "when a slot frees". SQLite cannot add a column only when it is missing, so a database that already has it (one migrated again after its version was set back) is left alone. */
const SCHEMA_V15 = (db: Database) => {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(loop_tasks)").all();
  if (!columns.some((c) => c.name === "after_task"))
    db.run("ALTER TABLE loop_tasks ADD COLUMN after_task TEXT");
};

/** Applies pending schema versions, tracked in `PRAGMA user_version`. */
export function migrate(db: Database): Database {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  const migrations = [
    SCHEMA_V1,
    SCHEMA_V2,
    SCHEMA_V3,
    SCHEMA_V4,
    SCHEMA_V5,
    SCHEMA_V6,
    SCHEMA_V7,
    SCHEMA_V8,
    SCHEMA_V9,
    SCHEMA_V10,
    SCHEMA_V11,
    SCHEMA_V12,
    SCHEMA_V13,
    SCHEMA_V14,
    SCHEMA_V15,
  ];
  for (const [i, schema] of migrations.entries()) {
    if (user_version > i) continue;
    db.transaction(() => {
      if (typeof schema === "string") db.run(schema);
      else schema(db);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

const DB_FILE = "claudebot.db";

/** Opens the database in the data root, creating the directory and the file on first run. */
export function openDb(dataRoot: string): Database {
  mkdirSync(dataRoot, { recursive: true });
  return migrate(new Database(join(dataRoot, DB_FILE), { create: true }));
}

/** The database file in the data root, and the write-ahead log and shared-memory files SQLite keeps beside it in WAL mode. */
export const dbFiles = (dataRoot: string): string[] => {
  const file = join(dataRoot, DB_FILE);
  return [file, `${file}-wal`, `${file}-shm`];
};
