import type { Database } from "bun:sqlite";

import type { WaitAction } from "@claudebot/contract/events";

export type WaitKind = "tool_approval" | "question" | "takeover" | "credential";
type WaitState = "open" | "answered" | "expired" | "cancelled";

/** What each kind stores about its request: enough to show the card, word the bot's message and carry out the effect after a restart. */
export interface WaitPayloads {
  /** `canonical` is `canonicalInput(input)`, which an `allow` is later matched against. */
  tool_approval: {
    tool: string;
    input: Record<string, unknown>;
    canonical: string;
    reason: string;
  };
  /** `eventId` is the external event the question is about; a linked question ends with its turn. */
  question: { question: string; options?: string[]; eventId?: string };
  takeover: { reason: string };
  credential: { entryId: string; label: string; origin: string; botName: string };
}

interface WaitBase {
  id: string;
  botId: string;
  /** The routine run the wait belongs to; null for an attended wait. */
  runId: string | null;
  /** The bot's session when the wait opened. */
  sessionId: string | null;
  actions: WaitAction[];
  state: WaitState;
  /** The action or answer picked, or `timeout`, `expired` or `cancelled`. */
  outcome: string | null;
  /** The owner's note with an answer, or why the host cancelled the wait. */
  note: string | null;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  consumedAt: number | null;
}

export type Wait<K extends WaitKind = WaitKind> = {
  [P in K]: WaitBase & { kind: P; payload: WaitPayloads[P] };
}[K];

interface Row {
  id: string;
  bot_id: string;
  kind: WaitKind;
  run_id: string | null;
  session_id: string | null;
  payload: string;
  actions: string;
  state: WaitState;
  outcome: string | null;
  note: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  consumed_at: number | null;
}

const toWait = (r: Row): Wait =>
  ({
    id: r.id,
    botId: r.bot_id,
    kind: r.kind,
    runId: r.run_id,
    sessionId: r.session_id,
    payload: JSON.parse(r.payload),
    actions: JSON.parse(r.actions),
    state: r.state,
    outcome: r.outcome,
    note: r.note,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    consumedAt: r.consumed_at,
  }) as Wait;

interface NewWait {
  id: string;
  botId: string;
  kind: WaitKind;
  runId: string | null;
  sessionId: string | null;
  payload: unknown;
  actions: WaitAction[];
  createdAt: number;
  expiresAt: number;
}

export interface WaitStore {
  insert(w: NewWait): void;
  get(id: string): Wait | undefined;
  /** Open waits, oldest first; every bot's when `botId` is omitted. */
  open(botId?: string): Wait[];
  /** Open waits whose expiry is at or before `at`. */
  overdue(at: number): Wait[];
  /** A run's waits that are open, or closed with their outcome not yet given to the bot, oldest first. */
  ofRun(runId: string): Wait[];
  /** Records that the run has given the bot the outcome of these waits. */
  markDelivered(ids: string[], at: number): void;
  /** Closes an open wait; false when it was not open. */
  close(
    id: string,
    state: Exclude<WaitState, "open">,
    outcome: string,
    note: string | undefined,
    at: number,
  ): boolean;
  /** Marks an `allow` as used; false when it was already used or has no such row. */
  markConsumed(id: string, at: number): boolean;
  /** Uses up the oldest unused `allow` of `botId` for `tool` with exactly the canonical input; false when there is none. */
  consumeAllowance(botId: string, tool: string, canonical: string, at: number): boolean;
  removeBot(botId: string): void;
}

export function createWaitStore(db: Database): WaitStore {
  const select = "SELECT * FROM human_waits";
  return {
    insert: (w) =>
      void db
        .query(
          `INSERT INTO human_waits (id, bot_id, kind, run_id, session_id, payload, actions, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          w.id,
          w.botId,
          w.kind,
          w.runId,
          w.sessionId,
          JSON.stringify(w.payload),
          JSON.stringify(w.actions),
          w.createdAt,
          w.expiresAt,
        ),
    get(id) {
      const row = db.query<Row, [string]>(`${select} WHERE id = ?`).get(id);
      return row ? toWait(row) : undefined;
    },
    open(botId) {
      const rows =
        botId === undefined
          ? db.query<Row, []>(`${select} WHERE state = 'open' ORDER BY created_at, rowid`).all()
          : db
              .query<Row, [string]>(
                `${select} WHERE state = 'open' AND bot_id = ? ORDER BY created_at, rowid`,
              )
              .all(botId);
      return rows.map(toWait);
    },
    overdue: (at) =>
      db
        .query<Row, [number]>(
          `${select} WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at, rowid`,
        )
        .all(at)
        .map(toWait),
    ofRun: (runId) =>
      db
        .query<Row, [string]>(
          `${select} WHERE run_id = ? AND (state = 'open' OR delivered_at IS NULL) ORDER BY created_at, rowid`,
        )
        .all(runId)
        .map(toWait),
    markDelivered(ids, at) {
      const mark = db.query(
        `UPDATE human_waits SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
      );
      for (const id of ids) mark.run(at, id);
    },
    close: (id, state, outcome, note, at) =>
      db
        .query(
          `UPDATE human_waits SET state = ?, outcome = ?, note = ?, resolved_at = ? WHERE id = ? AND state = 'open'`,
        )
        .run(state, outcome, note ?? null, at, id).changes > 0,
    markConsumed: (id, at) =>
      db
        .query(`UPDATE human_waits SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
        .run(at, id).changes > 0,
    consumeAllowance: (botId, tool, canonical, at) =>
      db
        .query(
          `UPDATE human_waits SET consumed_at = ?
           WHERE id = (
             SELECT id FROM human_waits
             WHERE bot_id = ? AND kind = 'tool_approval' AND state = 'answered' AND outcome = 'allow'
               AND consumed_at IS NULL
               AND json_extract(payload, '$.tool') = ? AND json_extract(payload, '$.canonical') = ?
             ORDER BY resolved_at, rowid LIMIT 1
           )`,
        )
        .run(at, botId, tool, canonical).changes > 0,
    removeBot: (botId) => void db.query(`DELETE FROM human_waits WHERE bot_id = ?`).run(botId),
  };
}
