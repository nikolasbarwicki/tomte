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

// Human waits (ADR-0009): every tool approval, question, takeover and credential approval a bot raises, kept so an open wait survives
// a restart. `payload` and `actions` are JSON, shaped by `kind`. `run_id` is null for an attended wait; it has no foreign key to
// `routine_runs`, whose rebuild would otherwise cascade into this table. `outcome` is the action or answer picked, or `timeout`,
// `expired` or `cancelled`; `note` is the owner's note, or why the host cancelled the wait. `consumed_at` marks an `allow` that the
// bot's next call with the same input has used.
const SCHEMA_V16 = `
CREATE TABLE IF NOT EXISTS human_waits (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool_approval','question','takeover','credential')),
  run_id TEXT,
  session_id TEXT,
  payload TEXT NOT NULL,
  actions TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','expired','cancelled')),
  outcome TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS human_waits_open ON human_waits(bot_id, created_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS human_waits_by_run ON human_waits(run_id) WHERE run_id IS NOT NULL;
`;

// A routine run can park (ADR-0009): `waiting` joins the run statuses. SQLite cannot change a CHECK, so `routine_runs` is rebuilt with
// its rows and rowids kept; the index went with the old table and is made again. `human_waits` has no foreign key to it, so the drop
// cascades nowhere. `human_waits.delivered_at` marks a wait of a run whose outcome the run has given the bot (in a resume message,
// or by continuing at once), so a restart between two answers of one park still delivers both together. A database migrated again
// after its version was set back (the old-database tests do) already has the wider table and the column, and one made by hand may
// have neither table; each is changed only when it needs it.
const REBUILD_ROUTINE_RUNS = `
CREATE TABLE routine_runs_v17 (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  scheduled_for INTEGER,               -- NULL for manual runs
  status TEXT NOT NULL CHECK (status IN ('running','waiting','succeeded','failed','interrupted','skipped')),
  session_id TEXT,
  output TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (routine_id, scheduled_for)   -- NULLs do not collide, so manual runs are unlimited
);
INSERT INTO routine_runs_v17 (rowid, id, routine_id, trigger, scheduled_for, status, session_id, output, error, started_at, finished_at)
  SELECT rowid, id, routine_id, trigger, scheduled_for, status, session_id, output, error, started_at, finished_at FROM routine_runs ORDER BY rowid;
DROP TABLE routine_runs;
ALTER TABLE routine_runs_v17 RENAME TO routine_runs;
CREATE INDEX routine_runs_by_routine ON routine_runs(routine_id, started_at DESC);
`;

const SCHEMA_V17 = (db: Database) => {
  const sql = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routine_runs'",
    )
    .get()?.sql;
  if (sql !== undefined && !sql.includes("'waiting'")) db.run(REBUILD_ROUTINE_RUNS);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(human_waits)").all();
  if (columns.length > 0 && !columns.some((c) => c.name === "delivered_at"))
    db.run("ALTER TABLE human_waits ADD COLUMN delivered_at INTEGER");
};

// Tools the owner chose "Always allow for this bot" on (ADR-0009): a rule is the tool's name and nothing more, kept per bot, and is
// read wherever a tool call would otherwise ask. Switching a tool off in Integrations still wins over it.
const SCHEMA_V18 = `
CREATE TABLE IF NOT EXISTS tool_allowances (
  bot_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, tool_name)
);
`;

// Channels (ADR-0010): the one account linked per channel, and the one-time codes that link it. Only a code's digest is stored;
// `failures` counts wrong code-shaped attempts and is reset on every code of the channel when a new one is created.
const SCHEMA_V19 = `
CREATE TABLE IF NOT EXISTS channel_links (
  channel TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_link_codes (
  channel TEXT NOT NULL,
  code_digest BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, code_digest)
);
`;

// The card a channel sent for one needs-you item: an open external event (`event`) or a human wait (`wait`). A card is sent once per item
// (the unique key), keeps the message reference its channel needs to edit it, and is closed once its item left `open` and the card was edited.
const SCHEMA_V20 = `
CREATE TABLE IF NOT EXISTS channel_cards (
  channel TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('event', 'wait')),
  item_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (channel, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS channel_cards_by_ref ON channel_cards (channel, message_ref);
`;

// A routine's opt-in to a short result on the owner's linked channel when a run succeeds; existing routines stay off. A database migrated
// again after its version was set back (the old-database tests do) already has the column, and one made by hand may have no table.
const SCHEMA_V21 = (db: Database) => {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(routines)").all();
  if (columns.length > 0 && !columns.some((c) => c.name === "notify_result"))
    db.run("ALTER TABLE routines ADD COLUMN notify_result INTEGER NOT NULL DEFAULT 0");
};

// A routine the host stopped says why (`paused_reason`), and `notice` joins the kinds of external event: the host's own needs-you
// items. SQLite cannot change a CHECK, so `external_events` is rebuilt as step 12 did, with its rows, rowids and the columns the
// relay steps added kept; the indexes went with the old table and are made again. A database migrated again after its version was
// set back (the old-database tests do) already has the column and the wider table; each is changed only when it needs it.
const REBUILD_EXTERNAL_EVENTS = `
CREATE TABLE external_events_v22 (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,                   -- the sender's dedupe key
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','blocked','failed','done','stopped','progress','notice')),
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,                        -- JSON array of suggested answers; questions only
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','acted','dismissed','resolved','info')),
  question_id TEXT,
  reply TEXT,                          -- JSON ReplyTarget
  relay_state TEXT NOT NULL DEFAULT 'none' CHECK (relay_state IN ('none','pending','relayed','failed')),
  relay_attempts INTEGER NOT NULL DEFAULT 0,
  relay_error TEXT,
  relay_answer TEXT,
  UNIQUE (bot_id, key)
);
INSERT INTO external_events_v22 (rowid, id, bot_id, key, source_id, kind, title, body, options, received_at, state, question_id, reply, relay_state, relay_attempts, relay_error, relay_answer)
  SELECT rowid, id, bot_id, key, source_id, kind, title, body, options, received_at, state, question_id, reply, relay_state, relay_attempts, relay_error, relay_answer FROM external_events ORDER BY rowid;
DROP TABLE external_events;
ALTER TABLE external_events_v22 RENAME TO external_events;
CREATE INDEX external_events_by_source ON external_events(bot_id, source_id, received_at);
CREATE INDEX external_events_open ON external_events(bot_id) WHERE state = 'open';
`;

const SCHEMA_V22 = (db: Database) => {
  const routines = db.query<{ name: string }, []>("PRAGMA table_info(routines)").all();
  if (routines.length > 0 && !routines.some((c) => c.name === "paused_reason"))
    db.run(
      "ALTER TABLE routines ADD COLUMN paused_reason TEXT CHECK (paused_reason IN ('failures','absence'))",
    );
  const sql = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_events'",
    )
    .get()?.sql;
  if (sql !== undefined && !sql.includes("'notice'")) db.run(REBUILD_EXTERNAL_EVENTS);
};

// Run usage: what the host last saw of each session's cumulative cost and tokens (a run's usage is the difference), and what each run
// used. A column is added only when missing, as in V15: SQLite has no ADD COLUMN IF NOT EXISTS.
const SCHEMA_V23 = (db: Database) => {
  db.run(`
CREATE TABLE IF NOT EXISTS session_usage_marks (
  session_id TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);
  const have = db.query<{ name: string }, []>("PRAGMA table_info(routine_runs)").all();
  for (const [name, type] of [
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_read_tokens", "INTEGER"],
    ["cache_creation_tokens", "INTEGER"],
    ["total_cost_usd", "REAL"],
    ["parked_ms", "INTEGER NOT NULL DEFAULT 0"],
  ] as const)
    if (have.length > 0 && !have.some((c) => c.name === name))
      db.run(`ALTER TABLE routine_runs ADD COLUMN ${name} ${type}`);
};

// Parked time: when a waiting run's park began and how long it had worked before it, so the park survives a restart and the run's
// clock goes on from its active time. Columns are added only when missing, as in V23.
const SCHEMA_V24 = (db: Database) => {
  const have = db.query<{ name: string }, []>("PRAGMA table_info(routine_runs)").all();
  for (const [name, type] of [
    ["parked_at", "INTEGER"],
    ["active_ms", "INTEGER NOT NULL DEFAULT 0"],
  ] as const)
    if (have.length > 0 && !have.some((c) => c.name === name))
      db.run(`ALTER TABLE routine_runs ADD COLUMN ${name} ${type}`);
};

// The owner's presence (the absence pause): one row with the time of the last action and the time of the last warning. It is in the
// database so a restart does not reset the clock.
const SCHEMA_V25 = `
CREATE TABLE IF NOT EXISTS presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_action_at INTEGER NOT NULL,
  last_warned_at INTEGER                -- when the warning of this absence was raised; null once the owner is back
);
`;

// Whose session a usage mark is, so deleting a bot can remove its marks. A mark is backfilled from the routine runs and double-loop
// rows that name its session; a chat session's mark stays null and is found through the bot's own session list when the bot is deleted.
const SCHEMA_V26 = (db: Database) => {
  const have = db.query<{ name: string }, []>("PRAGMA table_info(session_usage_marks)").all();
  if (!have.some((c) => c.name === "bot_id"))
    db.run("ALTER TABLE session_usage_marks ADD COLUMN bot_id TEXT");
  db.run("CREATE INDEX IF NOT EXISTS session_usage_marks_bot ON session_usage_marks(bot_id)");
  // A database that skipped the early steps has no run history to backfill from.
  const sources = db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('routines', 'routine_runs', 'loop_tasks', 'loop_events')",
    )
    .get()!.n;
  if (sources < 4) return;
  db.run(`
UPDATE session_usage_marks SET bot_id = COALESCE(
  (SELECT r.bot_id FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id
     WHERE rr.session_id = session_usage_marks.session_id LIMIT 1),
  (SELECT bot_id FROM loop_tasks WHERE session_id = session_usage_marks.session_id LIMIT 1),
  (SELECT bot_id FROM loop_events WHERE session_id = session_usage_marks.session_id LIMIT 1)
) WHERE bot_id IS NULL;`);
};

// When a routine was last switched back on: only runs that started since count toward its pause after failed runs, so a resume
// means "try again". Null, as for every routine before this step, counts all its runs.
const SCHEMA_V27 = (db: Database) => {
  const have = db.query<{ name: string }, []>("PRAGMA table_info(routines)").all();
  if (have.length > 0 && !have.some((c) => c.name === "failures_from"))
    db.run("ALTER TABLE routines ADD COLUMN failures_from INTEGER");
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
    SCHEMA_V16,
    SCHEMA_V17,
    SCHEMA_V18,
    SCHEMA_V19,
    SCHEMA_V20,
    SCHEMA_V21,
    SCHEMA_V22,
    SCHEMA_V23,
    SCHEMA_V24,
    SCHEMA_V25,
    SCHEMA_V26,
    SCHEMA_V27,
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
