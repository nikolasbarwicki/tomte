import { randomBytes } from "node:crypto";

import type { ServerEvent } from "@claudebot/contract/events";

import { isFinal, type LoopTask, type SessionLog } from "./store.ts";
import { MAX_FINDINGS, type TaskView, type WorkTask } from "./work-state.ts";

/** How long a dispatched queue entry may wait for its agent to start before the front is asked again. */
export const DISPATCH_TIMEOUT_MS = 120_000;
/** How often the front is asked to start a queue entry before the entry fails. */
export const MAX_DISPATCHES = 2;
/** How often the queue is looked at, apart from the moments a task changes. */
const PUMP_EVERY_MS = 5000;

/** What a task's agent verified so far, newest last: the findings of its progress records, as the page and the work state list them. */
export function findingsOf(log: SessionLog, taskId: string): string[] {
  return log
    .events("progress", taskId)
    .flatMap((e) => (e.progress.finding ? [e.progress.finding.replace(/\s+/g, " ").trim()] : []))
    .slice(-MAX_FINDINGS);
}

/** A task as the page shows it; `findings` are what its agent verified so far, newest last. */
export function taskEvent(
  t: LoopTask,
  findings: readonly string[] = [],
): Extract<ServerEvent, { type: "task" }> {
  return {
    type: "task",
    taskId: t.taskId,
    ...(t.agentType !== undefined && { agentType: t.agentType }),
    ...(t.model !== undefined && { model: t.model }),
    ...(t.effort !== undefined && { effort: t.effort }),
    goal: t.goal,
    state: t.status,
    startedAt: t.startedAt,
    ...(t.endedAt !== undefined && { endedAt: t.endedAt }),
    ...(t.after !== undefined && { after: t.after }),
    ...(findings.length > 0 && { findings: [...findings] }),
  };
}

/** What the work state knows about a running task beyond the task row. */
export interface TaskDetail {
  line?: string | undefined;
  findings?: readonly string[] | undefined;
  steers?: number | undefined;
}

/**
 * The tasks of a session grouped as the work state lists them, in the order the log holds them. A task that holds a slot is
 * running or interrupted (a restart cut it off; a steer can still continue it), a queued one waits, and an ended one is final;
 * `ended` is oldest end first. `detail` adds the status line and findings of the tasks that hold a slot.
 */
export function foldTasks(
  tasks: readonly LoopTask[],
  detail: (t: LoopTask) => TaskDetail = () => ({}),
): TaskView {
  const work = (t: LoopTask, extra: TaskDetail = {}): WorkTask => ({
    taskId: t.taskId,
    agentType: t.agentType,
    model: t.model,
    effort: t.effort,
    goal: t.goal,
    since: t.startedAt,
    status: t.status,
    after: t.after ?? null,
    ...extra,
  });
  return {
    running: tasks
      .filter((t) => t.status === "running" || t.status === "interrupted")
      .map((t) => work(t, detail(t))),
    queued: tasks.filter((t) => t.status === "queued").map((t) => work(t)),
    ended: tasks
      .filter((t) => isFinal(t.status))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map((t) => work(t)),
  };
}

export type QueueResult = { ok: true; id: string } | { ok: false; error: string };

export interface TasksDeps {
  log: SessionLog;
  /** Agent slots; a queue entry is due only while one is free. */
  maxParallel: number;
  /** Asks the front to start a queue entry: gives it a synthetic message. */
  dispatch: (message: string) => void;
  /** Shows the page a queued task, or one that failed to start. */
  emit: (e: ServerEvent) => void;
  now?: () => number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every?: (fn: () => void, ms: number) => () => void;
  dispatchTimeoutMs?: number;
}

/**
 * The app queue of one session, over the task log: a queued task waits for a free slot and, when it has one, for the task it
 * follows to end. Once it is due the front is asked to start it, and the Agent call that names its id claims it. A request the
 * front does not answer is repeated, and a queued task that stays unanswered fails.
 */
export class Tasks {
  /** Queue entries the front was asked to start and whose agent has not started yet; `at` 0 is a request that timed out. */
  private readonly dispatched = new Map<string, { at: number; attempts: number }>();
  /** The agent id each started queue entry became, so the front's old ids keep working. */
  private readonly startedAs = new Map<string, string>();
  private readonly now: () => number;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private stopTimer: (() => void) | undefined;
  private pumping = false;
  private disposed = false;

  constructor(private readonly d: TasksDeps) {
    this.now = d.now ?? Date.now;
    this.every =
      d.every ??
      ((fn, ms) => {
        const timer = setInterval(fn, ms);
        timer.unref();
        return () => clearInterval(timer);
      });
    this.sync();
  }

  /** The agent id a queue id became, or the id itself. */
  resolve(id: string): string {
    return this.startedAs.get(id) ?? id;
  }

  private get(id: string): LoopTask | undefined {
    return this.d.log.getTask(this.resolve(id));
  }

  queue(goal: string, agentType: string, after: string | null): QueueResult {
    let waitsFor: string | undefined;
    if (after !== null) {
      const target = this.get(after);
      if (!target)
        return {
          ok: false,
          error: `No task with id ${after}. Use an id from <work_state>, or null.`,
        };
      if (!isFinal(target.status)) waitsFor = target.taskId;
    }
    const id = `q-${randomBytes(4).toString("hex")}`;
    this.d.log.putTask(
      { taskId: id, agentType, goal, status: "queued", startedAt: this.now(), after: waitsFor },
      this.now(),
    );
    this.emitTask(id);
    this.pump();
    return { ok: true, id };
  }

  cancelQueued(id: string): QueueResult {
    const t = this.d.log.getTask(id);
    if (t?.status !== "queued")
      return {
        ok: false,
        error: `No queued task with id ${id}. Running tasks are stopped with TaskStop.`,
      };
    this.cancel(t);
    this.sync();
    return { ok: true, id };
  }

  /** Cancels every queued task, as when the session they belong to ends. */
  cancelAllQueued(): void {
    for (const t of this.d.log.tasks()) if (t.status === "queued") this.cancel(t);
    this.sync();
  }

  private cancel(t: LoopTask) {
    this.dispatched.delete(t.taskId);
    this.d.log.setStatus(t.taskId, "cancelled", this.now());
    this.emitTask(t.taskId);
  }

  /** The dispatched queue entry an Agent call belongs to: the one it names. */
  claim(call: {
    name?: string | undefined;
    description?: string | undefined;
    prompt?: string | undefined;
  }): string | undefined {
    for (const id of this.dispatched.keys())
      if (call.name === id || call.description?.includes(id) || call.prompt?.includes(id))
        return id;
    return undefined;
  }

  /** The agent `taskId` started the dispatched queue entry `queuedId`: the entry's row goes, and the tasks that waited for it wait for the agent. Returns the entry. */
  started(queuedId: string, taskId: string): LoopTask | undefined {
    const entry = this.d.log.getTask(queuedId);
    this.dispatched.delete(queuedId);
    if (entry?.status !== "queued") return undefined;
    this.d.log.removeTask(queuedId);
    this.d.log.retarget(queuedId, taskId);
    this.startedAs.set(queuedId, taskId);
    return entry;
  }

  /** Queue entries whose wait is over, as many as there are free slots, in the order they were queued. */
  due(): LoopTask[] {
    const now = this.now();
    const timeout = this.d.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS;
    for (const [id, req] of this.dispatched)
      if (req.at > 0 && now - req.at > timeout) this.dispatched.set(id, { ...req, at: 0 });
    const tasks = this.d.log.tasks();
    const holding = tasks.filter(
      (t) => t.status === "running" || t.status === "interrupted",
    ).length;
    const waiting = [...this.dispatched.values()].filter((req) => req.at > 0).length;
    let free = this.d.maxParallel - holding - waiting;
    const due: LoopTask[] = [];
    for (const t of tasks) {
      if (free <= 0) break;
      if (t.status !== "queued" || (this.dispatched.get(t.taskId)?.at ?? 0) > 0) continue;
      if (t.after !== undefined) {
        const blocker = this.get(t.after);
        if (blocker && !isFinal(blocker.status)) continue;
      }
      due.push(t);
      free--;
    }
    return due;
  }

  /** Asks the front to start what is due, and fails what it did not start after repeated requests. Called whenever a task changes and on a timer. */
  pump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      for (const t of this.due()) {
        const attempts = (this.dispatched.get(t.taskId)?.attempts ?? 0) + 1;
        if (attempts > MAX_DISPATCHES) {
          this.dispatched.delete(t.taskId);
          this.d.log.setStatus(t.taskId, "failed", this.now());
          this.emitTask(t.taskId);
          continue;
        }
        this.dispatched.set(t.taskId, { at: this.now(), attempts });
        this.d.dispatch(
          `Start queued task ${t.taskId} (agent: ${t.agentType ?? "researcher"}): ${t.goal}`,
        );
      }
    } finally {
      this.pumping = false;
    }
    this.sync();
  }

  /** The queue is looked at on a timer only while something is queued. */
  private sync() {
    const queued = !this.disposed && this.d.log.tasks().some((t) => t.status === "queued");
    if (queued && !this.stopTimer) this.stopTimer = this.every(() => this.pump(), PUMP_EVERY_MS);
    else if (!queued && this.stopTimer) {
      this.stopTimer();
      this.stopTimer = undefined;
    }
  }

  /** Stops looking at the queue, as when the chat is gone; what is stored stays. */
  dispose(): void {
    this.disposed = true;
    this.sync();
  }

  private emitTask(taskId: string) {
    const t = this.d.log.getTask(taskId);
    if (t) this.d.emit(taskEvent(t));
  }
}
