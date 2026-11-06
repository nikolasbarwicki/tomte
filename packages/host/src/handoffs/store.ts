import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/** A2A task states. `completed`, `failed` and `canceled` are final; A2A `rejected` is folded into `failed`. */
export type HandoffStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";
type MessageKind = "brief" | "message" | "result" | "failure" | "cancel";

export const FINAL_STATUSES: readonly HandoffStatus[] = ["completed", "failed", "canceled"];

export type Handoff = {
  id: string;
  requesterId: string;
  assigneeId: string;
  title: string;
  brief: string;
  status: HandoffStatus;
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

type HandoffMessage = {
  id: string;
  handoffId: string;
  senderId: string;
  kind: MessageKind;
  text: string;
  createdAt: number;
};

type HandoffRow = {
  id: string;
  requester_id: string;
  assignee_id: string;
  title: string;
  brief: string;
  status: HandoffStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  handoff_id: string;
  sender_id: string;
  kind: MessageKind;
  text: string;
  created_at: number;
};

const toHandoff = (r: HandoffRow): Handoff => ({
  id: r.id,
  requesterId: r.requester_id,
  assigneeId: r.assignee_id,
  title: r.title,
  brief: r.brief,
  status: r.status,
  result: r.result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): HandoffMessage => ({
  id: r.id,
  handoffId: r.handoff_id,
  senderId: r.sender_id,
  kind: r.kind,
  text: r.text,
  createdAt: r.created_at,
});

/** What one state change records: the new status and the message that caused it. */
type Transition = {
  senderId: string;
  kind: MessageKind;
  text: string;
  status: HandoffStatus;
  result?: string;
};

/** Owns every handoff state change; nothing else writes the handoff tables. */
export interface HandoffStore {
  /** Creates a handoff in `submitted` together with its brief message. */
  create(input: { requesterId: string; assigneeId: string; title: string; brief: string }): Handoff;
  get(id: string): Handoff | undefined;
  /** Messages of a handoff, oldest first. */
  messages(id: string): HandoffMessage[];
  /** Records `t.text` as a message of `t.kind` and moves the handoff to `t.status`. Throws if the handoff does not exist. */
  transition(id: string, t: Transition): Handoff;
  /** Moves a `submitted` handoff to `working`; any other status is left alone. */
  start(id: string): void;
  /** Handoffs of `botId` (either party) that are not final, oldest first. */
  openFor(botId: string): Handoff[];
  /** Every handoff that is not final, oldest first. */
  open(): Handoff[];
  /** Requester to assignee of every handoff not yet in a final status; one entry per open handoff. */
  openEdges(): { requesterId: string; assigneeId: string }[];
}

export function createHandoffStore(db: Database, now: () => number = Date.now): HandoffStore {
  const get = (id: string) => {
    const r = db.query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE id = ?").get(id);
    return r ? toHandoff(r) : undefined;
  };
  const insertMessage = (
    handoffId: string,
    senderId: string,
    kind: MessageKind,
    text: string,
    at: number,
  ) =>
    db
      .query(
        "INSERT INTO handoff_messages (id, handoff_id, sender_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), handoffId, senderId, kind, text, at);

  return {
    create: (i) =>
      db.transaction(() => {
        const id = randomUUID();
        const at = now();
        db.query(
          "INSERT INTO handoffs (id, requester_id, assignee_id, title, brief, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'submitted', NULL, ?, ?)",
        ).run(id, i.requesterId, i.assigneeId, i.title, i.brief, at, at);
        insertMessage(id, i.requesterId, "brief", i.brief, at);
        return get(id)!;
      })(),

    get,

    openEdges: () =>
      db
        .query<{ requester_id: string; assignee_id: string }, []>(
          "SELECT requester_id, assignee_id FROM handoffs WHERE status NOT IN ('completed', 'failed', 'canceled')",
        )
        .all()
        .map((r) => ({ requesterId: r.requester_id, assigneeId: r.assignee_id })),

    messages: (id) =>
      db
        .query<MessageRow, [string]>(
          "SELECT * FROM handoff_messages WHERE handoff_id = ? ORDER BY created_at, rowid",
        )
        .all(id)
        .map(toMessage),

    transition: (id, t) =>
      db.transaction(() => {
        const at = now();
        const changed = db
          .query(
            "UPDATE handoffs SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?",
          )
          .run(t.status, t.result ?? null, at, id).changes;
        if (!changed) throw new Error(`no handoff ${id}`);
        insertMessage(id, t.senderId, t.kind, t.text, at);
        return get(id)!;
      })(),

    start: (id) =>
      void db
        .query(
          "UPDATE handoffs SET status = 'working', updated_at = ? WHERE id = ? AND status = 'submitted'",
        )
        .run(now(), id),

    open: () =>
      db
        .query<HandoffRow, []>(
          "SELECT * FROM handoffs WHERE status IN ('submitted', 'working', 'input-required') ORDER BY created_at, rowid",
        )
        .all()
        .map(toHandoff),

    openFor: (botId) =>
      db
        .query<HandoffRow, [string, string]>(
          "SELECT * FROM handoffs WHERE (requester_id = ? OR assignee_id = ?) AND status IN ('submitted', 'working', 'input-required') ORDER BY created_at, rowid",
        )
        .all(botId, botId)
        .map(toHandoff),
  };
}
