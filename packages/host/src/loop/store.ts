import type { Database } from "bun:sqlite";

import type { TaskState } from "@claudebot/contract/events";
import { z } from "zod";

/** One background task of a bot's session, as the store holds it. */
export interface LoopTask {
  taskId: string;
  agentType?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  /** What the task was asked to do, in one line. */
  goal: string;
  status: TaskState;
  startedAt: number;
  updatedAt: number;
  endedAt?: number | undefined;
  /** A queued task: the task it waits for; absent for "when a slot frees". */
  after?: string | undefined;
}

/** What an agent reports through `record_progress`; the app attributes it to its task. */
export interface Progress {
  phase: string;
  finding: string | null;
  next: string;
}

export type ActivityType = "search" | "open" | "tool";

/** A row of the append-only log, without the task and time every row has. */
type LoopEventBody =
  | { kind: "progress"; progress: Progress }
  | { kind: "activity"; type: ActivityType; text: string }
  | { kind: "steer"; state: "sent" | "failed"; text: string }
  | { kind: "report"; text: string };

type LoopEvent = LoopEventBody & { taskId: string; at: number };

/** The JSON a row keeps in `data`: the body without its `kind`, which has a column of its own. */
const Data = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("progress"),
    progress: z.object({ phase: z.string(), finding: z.string().nullable(), next: z.string() }),
  }),
  z.object({
    kind: z.literal("activity"),
    type: z.enum(["search", "open", "tool"]),
    text: z.string(),
  }),
  z.object({ kind: z.literal("steer"), state: z.enum(["sent", "failed"]), text: z.string() }),
  z.object({ kind: z.literal("report"), text: z.string() }),
]);

type TaskRow = {
  task_id: string;
  agent_type: string | null;
  model: string | null;
  effort: string | null;
  goal: string;
  status: TaskState;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  after_task: string | null;
};

type EventRow = { task_id: string; at: number; data: string };

const task = (r: TaskRow): LoopTask => ({
  taskId: r.task_id,
  ...(r.agent_type !== null && { agentType: r.agent_type }),
  ...(r.model !== null && { model: r.model }),
  ...(r.effort !== null && { effort: r.effort }),
  goal: r.goal,
  status: r.status,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  ...(r.ended_at !== null && { endedAt: r.ended_at }),
  ...(r.after_task !== null && { after: r.after_task }),
});

const event = (r: EventRow): LoopEvent => ({
  ...Data.parse(JSON.parse(r.data)),
  taskId: r.task_id,
  at: r.at,
});

/** The tasks and log of one bot session. */
export interface SessionLog {
  /** Creates the task, or replaces everything but its start when it exists already; the row is what `status` says from now on. */
  putTask(t: Omit<LoopTask, "updatedAt">, now: number): void;
  getTask(taskId: string): LoopTask | undefined;
  /** Forgets a task, as when a queue entry becomes the agent that runs it. */
  removeTask(taskId: string): void;
  /** Points the queued tasks that wait for `from` at `to`. */
  retarget(from: string, to: string): void;
  /** Every task of the session, oldest start first. */
  tasks(): LoopTask[];
  /** Moves a task to `status`; `endedAt` is set for a final one and cleared otherwise. */
  setStatus(taskId: string, status: TaskState, now: number): void;
  append(e: LoopEvent): void;
  /** The session's log rows of `kind`, oldest first. */
  events<K extends LoopEventBody["kind"]>(kind: K, taskId?: string): (LoopEvent & { kind: K })[];
}

export interface LoopStore {
  session(botId: string, sessionId: string): SessionLog;
  /** True while any session of the bot has a task running or queued. */
  hasActive(botId: string): boolean;
  /** Marks every task still running as interrupted, as at a host start, when no agent can be alive; returns how many. */
  interruptRunning(now: number): number;
  /** Forgets everything stored for a deleted bot. */
  removeBot(botId: string): void;
}

/** Whether a task in this state is over, as opposed to queued, running or interrupted (which a steer can continue). */
export const isFinal = (s: TaskState) => s === "done" || s === "failed" || s === "cancelled";

/** SQLite access for `loop_tasks` and `loop_events` (`SCHEMA_V14`). */
export function createLoopStore(db: Database): LoopStore {
  return {
    session(botId, sessionId) {
      const getTask = (taskId: string) => {
        const r = db
          .query<TaskRow, [string, string, string]>(
            `SELECT task_id, agent_type, model, effort, goal, status, started_at, updated_at, ended_at, after_task
             FROM loop_tasks WHERE bot_id = ? AND session_id = ? AND task_id = ?`,
          )
          .get(botId, sessionId, taskId);
        return r ? task(r) : undefined;
      };
      return {
        putTask(t, now) {
          db.query(
            `INSERT INTO loop_tasks (bot_id, session_id, task_id, agent_type, model, effort, goal, status, started_at, updated_at, ended_at, after_task)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (bot_id, session_id, task_id) DO UPDATE SET
               agent_type = excluded.agent_type, model = excluded.model, effort = excluded.effort, goal = excluded.goal,
               status = excluded.status, updated_at = excluded.updated_at, ended_at = excluded.ended_at,
               after_task = excluded.after_task`,
          ).run(
            botId,
            sessionId,
            t.taskId,
            t.agentType ?? null,
            t.model ?? null,
            t.effort ?? null,
            t.goal,
            t.status,
            t.startedAt,
            now,
            t.endedAt ?? null,
            t.after ?? null,
          );
        },
        getTask,
        removeTask(taskId) {
          db.query(
            "DELETE FROM loop_tasks WHERE bot_id = ? AND session_id = ? AND task_id = ?",
          ).run(botId, sessionId, taskId);
        },
        retarget(from, to) {
          db.query(
            "UPDATE loop_tasks SET after_task = ? WHERE bot_id = ? AND session_id = ? AND after_task = ?",
          ).run(to, botId, sessionId, from);
        },
        tasks: () =>
          db
            .query<TaskRow, [string, string]>(
              `SELECT task_id, agent_type, model, effort, goal, status, started_at, updated_at, ended_at, after_task
               FROM loop_tasks WHERE bot_id = ? AND session_id = ? ORDER BY started_at, rowid`,
            )
            .all(botId, sessionId)
            .map(task),
        setStatus(taskId, status, now) {
          db.query(
            `UPDATE loop_tasks SET status = ?, updated_at = ?, ended_at = ?
             WHERE bot_id = ? AND session_id = ? AND task_id = ?`,
          ).run(status, now, isFinal(status) ? now : null, botId, sessionId, taskId);
        },
        append({ taskId, at, ...body }) {
          db.query(
            "INSERT INTO loop_events (bot_id, session_id, task_id, at, kind, data) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(botId, sessionId, taskId, at, body.kind, JSON.stringify(body));
        },
        events<K extends LoopEventBody["kind"]>(kind: K, taskId?: string) {
          const rows =
            taskId === undefined
              ? db
                  .query<EventRow, [string, string, string]>(
                    "SELECT task_id, at, data FROM loop_events WHERE bot_id = ? AND session_id = ? AND kind = ? ORDER BY id",
                  )
                  .all(botId, sessionId, kind)
              : db
                  .query<EventRow, [string, string, string, string]>(
                    "SELECT task_id, at, data FROM loop_events WHERE bot_id = ? AND session_id = ? AND kind = ? AND task_id = ? ORDER BY id",
                  )
                  .all(botId, sessionId, kind, taskId);
          return rows.map(event) as (LoopEvent & { kind: K })[];
        },
      };
    },
    hasActive: (botId) =>
      db
        .query<unknown, [string]>(
          "SELECT 1 FROM loop_tasks WHERE bot_id = ? AND status IN ('queued','running') LIMIT 1",
        )
        .get(botId) !== null,
    interruptRunning(now) {
      return db
        .query(
          "UPDATE loop_tasks SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
        )
        .run(now).changes;
    },
    removeBot(botId) {
      db.query("DELETE FROM loop_tasks WHERE bot_id = ?").run(botId);
      db.query("DELETE FROM loop_events WHERE bot_id = ?").run(botId);
    },
  };
}
