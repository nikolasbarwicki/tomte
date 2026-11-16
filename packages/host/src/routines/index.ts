import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, Routine, RoutineRun, RunTrigger, Schedule } from "@claudebot/contract/events";
import { z } from "zod";

import {
  currentSession,
  getBot,
  openThread,
  touchBot,
  type HostDelegate,
  type Thread,
  type ThreadEnv,
} from "../bots/index.ts";
import { NotFound } from "../platform/errors.ts";
import type { Wait, Waits } from "../waits/index.ts";
import { parkingDelegate } from "./parking.ts";
import {
  WINDOW_MS,
  hasOccurrence,
  latestOccurrence,
  nextOccurrence,
  nextOccurrences,
  parseSchedule,
} from "./schedule.ts";
import * as store from "./store.ts";
import type { RoutineRecord } from "./store.ts";

export { parkingDelegate };

export class Conflict extends Error {}

/** HTTP-boundary schema for a routine's editable fields. */
export const RoutineInput = z.object({
  name: z.string().trim().min(1, "name required"),
  instruction: z.string().trim().min(1, "instruction required"),
  schedule: z.unknown().transform((v, ctx) => {
    try {
      return parseSchedule(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  }),
  active: z.boolean().optional(),
  catchUp: z.boolean().optional(),
});
export type RoutineInput = z.output<typeof RoutineInput>;

/** HTTP-boundary schema for a routine edit: any subset of the editable fields, each exactly as `RoutineInput` has it. */
export const RoutinePatch = z.object({
  name: RoutineInput.shape.name.exactOptional(),
  instruction: RoutineInput.shape.instruction.exactOptional(),
  schedule: RoutineInput.shape.schedule.exactOptional(),
  active: z.boolean().exactOptional(),
  catchUp: z.boolean().exactOptional(),
});
export type RoutinePatch = z.output<typeof RoutinePatch>;

/** One agent turn of a routine run. A run has one turn, or more when it parks: each answer resumes it in the same session. */
export type RoutineJob = {
  bot: Bot;
  routine: RoutineRecord;
  prompt: string;
  /** The run this turn belongs to, whichever turn of it this is. */
  runId: string;
  trigger: RunTrigger;
  /** True for a turn that resumes a parked run: its prompt carries the owner's answers, not the routine's instruction. */
  resumed: boolean;
};

/** One agent turn in the bot's chat session; `done` resolves to the final text, `stop` ends it early (rejecting `done`). */
export type Executor = (job: RoutineJob) => {
  done: Promise<string>;
  stop: (reason: string) => void;
};

/** A run in progress; `removed` marks one stopped by `remove()`, whose row the cascade already owns. */
type LiveRun = {
  runId: string;
  stop?: (reason: string) => void;
  done: Promise<void>;
  removed?: boolean;
};

const LATE_NOTE_MS = 15 * 60_000;
/** setTimeout's delay is a signed 32-bit int; longer waits re-arm in steps. */
const MAX_TIMEOUT_MS = 2_147_000_000;

/** Runs a routine turn in the bot's own session without the UI, for a bot that is not open. `delegate` answers what the bot asks during the turn. */
export function runHeadless(
  env: ThreadEnv,
  { bot, routine, prompt }: RoutineJob,
  delegate: HostDelegate,
): ReturnType<Executor> {
  let thread: Thread | undefined;
  let stopped: string | undefined;
  const done = (async () => {
    const sessionId = currentSession(bot);
    const resume = sessionId !== undefined && !!(await getSessionInfo(sessionId, { dir: env.cwd }));
    if (stopped) throw new Error(stopped);
    thread = openThread(env, bot, {
      resume,
      delegate,
      log: (l) => console.error(`[routine ${routine.name}] ${l}`),
    });
    touchBot(env.dataRoot, bot);
    try {
      return (await thread.send(prompt)).text;
    } finally {
      thread.close("routine done");
    }
  })();
  return {
    done,
    stop: (reason) => {
      stopped = reason;
      thread?.close(reason);
    },
  };
}

function prompt(
  r: RoutineRecord,
  trigger: RunTrigger,
  scheduledFor: number | null,
  lateMs: number,
) {
  const late =
    lateMs > LATE_NOTE_MS
      ? `This run started ${Math.round(lateMs / 60_000)} minutes late because the app was offline; adjust any time-of-day assumptions.`
      : "";
  const when = scheduledFor === null ? "now" : new Date(scheduledFor).toISOString();
  return [
    `<scheduled-routine name="${r.name.replace(/"/g, "'")}" trigger="${trigger}" scheduled-for="${when}">`,
    "No human is watching this run, but you can reach the owner: a tool that needs approval, and the ask_user tool, send the request to the owner and park this run until they answer. The answer arrives later as a message in this conversation. After sending such a request, end your turn; do not guess, retry or wait. Otherwise carry out the instruction below on your own. Save anything you produce in your files folder. End with a short summary (at most 5 lines) of what you did and what the user should know.",
    late,
    "",
    r.instruction,
    "</scheduled-routine>",
  ].join("\n");
}

export function createRoutines(deps: {
  db: Database;
  dataRoot: string;
  now?: () => number;
  execute: Executor;
  onChange: (botId: string) => void;
  /** The human waits of a run: what it is waiting for, what the owner answered, and the cancelling of what an ended run left open. */
  waits: Pick<Waits, "ofRun" | "cancelRun" | "resultText" | "delivered">;
  /** Shows the owner a line in the bot's chat. */
  notice(botId: string, text: string): Promise<void>;
  /** Sends a host message into the bot's session through the normal send path (queued while the bot is busy). */
  deliver(botId: string, text: string): Promise<void>;
}) {
  const { db, dataRoot, onChange, execute, waits } = deps;
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, { stop: () => void }>();
  const running = new Map<string, LiveRun>();

  const require = (id: string) => {
    const r = store.getRoutine(db, id);
    if (!r) throw new NotFound("no such routine");
    return r;
  };

  function disarm(id: string) {
    jobs.get(id)?.stop();
    jobs.delete(id);
  }

  function arm(r: RoutineRecord) {
    disarm(r.id);
    if (!r.active || !getBot(dataRoot, r.botId)) return;
    const s = r.schedule;
    if (s.kind === "cron") {
      const job = Bun.cron(s.expr, () => fire(r.id), { tz: s.tz });
      jobs.set(r.id, { stop: () => job.stop() });
      return;
    }
    const delay = s.at - now();
    if (r.lastScheduledFor !== null || delay <= 0) return;
    const capped = delay > MAX_TIMEOUT_MS;
    const timer = setTimeout(
      () => {
        jobs.delete(r.id);
        if (!capped) return void fire(r.id);
        const fresh = store.getRoutine(db, r.id);
        if (fresh) arm(fresh);
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    jobs.set(r.id, { stop: () => clearTimeout(timer) });
  }

  function skip(r: RoutineRecord, scheduledFor: number, error: string) {
    const t = now();
    store.insertRun(db, {
      id: randomUUID(),
      routineId: r.id,
      trigger: "schedule",
      scheduledFor,
      status: "skipped",
      sessionId: null,
      output: null,
      error,
      startedAt: t,
      finishedAt: t,
    });
    onChange(r.botId);
  }

  /** Single path for scheduled and caught-up runs; spurious or duplicate wakes are no-ops. */
  async function fire(id: string) {
    try {
      const r = store.getRoutine(db, id);
      if (!r?.active) return;
      const t = latestOccurrence(r.schedule, r.lastScheduledFor ?? r.createdAt, now());
      if (t === null) {
        if (r.schedule.kind === "once") arm(r);
        return;
      }
      if (!store.claimOccurrence(db, id, t)) return;
      if (r.schedule.kind === "once") {
        store.deactivateRoutine(db, id, now());
        disarm(id);
      }
      if (running.has(id)) return skip(r, t, "previous run still in progress");
      if (store.waitingRun(db, id)) return skip(r, t, "previous run is waiting for you");
      await run(r, "schedule", t).done;
    } catch (e) {
      console.error(`[routines] fire ${id} failed: ${(e as Error).message}`);
    }
  }

  /** Inserts the run row synchronously; the agent works in the background until `done`. */
  function run(
    r: RoutineRecord,
    trigger: RunTrigger,
    scheduledFor: number | null,
  ): { row: RoutineRun; done: Promise<void> } {
    const bot = getBot(dataRoot, r.botId);
    const startedAt = now();
    const row: RoutineRun = {
      id: randomUUID(),
      routineId: r.id,
      trigger,
      scheduledFor,
      status: bot ? "running" : "failed",
      sessionId: bot ? (currentSession(bot) ?? null) : null,
      output: null,
      error: bot ? null : "bot no longer exists",
      startedAt,
      finishedAt: bot ? null : startedAt,
    };
    store.insertRun(db, row);
    if (!bot) {
      onChange(r.botId);
      return { row, done: Promise.resolve() };
    }
    const first = prompt(
      r,
      trigger,
      scheduledFor,
      scheduledFor === null ? 0 : startedAt - scheduledFor,
    );
    return { row, done: begin(r, row, bot, first, false) };
  }

  /** Makes the run the routine's one run in flight and drives it until it ends or parks. */
  function begin(r: RoutineRecord, row: RoutineRun, bot: Bot, first: string, resumed: boolean) {
    const entry: LiveRun = { runId: row.id, done: Promise.resolve() };
    running.set(r.id, entry);
    onChange(r.botId);
    entry.done = drive(entry, r, row, bot, first, resumed);
    return entry.done;
  }

  /**
   * The turns of one run in the bot's session: the first, then one more each time the owner's answers are already in when a turn
   * ends. The turn-end rule decides what a turn that succeeded means: a request to the owner still open parks the run (the single
   * place a run enters `waiting`); answers that came in while the turn still ran continue it at once; a wait that expired fails it.
   */
  async function drive(
    entry: LiveRun,
    r: RoutineRecord,
    row: RoutineRun,
    bot: Bot,
    first: string,
    resumed: boolean,
  ) {
    try {
      let message = first;
      let isResume = resumed;
      for (;;) {
        const job = execute({
          bot,
          routine: r,
          prompt: message,
          runId: row.id,
          trigger: row.trigger,
          resumed: isResume,
        });
        entry.stop = job.stop;
        const text = await job.done;
        if (entry.removed) return;
        const pending = waits.ofRun(row.id);
        if (pending.some((w) => w.state === "open")) {
          store.parkRun(db, row.id);
          return;
        }
        if (pending.some((w) => w.state === "expired")) return expire(row.id);
        if (pending.length === 0) {
          store.finishRun(db, row.id, "succeeded", { output: text, finishedAt: now() });
          return;
        }
        message = waits.resultText(pending);
        waits.delivered(pending);
        isResume = true;
      }
    } catch (e) {
      if (entry.removed) return;
      endRun(row.id, (e as Error).message);
    } finally {
      if (running.get(r.id) === entry) running.delete(r.id);
      onChange(r.botId);
    }
  }

  /** Fails a run that has not ended and cancels what it still waits for, telling nobody; false when the run had ended. */
  function endRun(runId: string, error: string): boolean {
    if (!store.finishRun(db, runId, "failed", { error, finishedAt: now() })) return false;
    waits.cancelRun(runId, error);
    return true;
  }

  /** A parked run's answers are all in: runs its session on with them. The single place a run leaves `waiting` for `running`. */
  async function resume(runId: string, message: string): Promise<void> {
    const row = store.getRun(db, runId);
    if (row?.status !== "waiting") throw new Conflict("run is not waiting");
    const r = require(row.routineId);
    const bot = getBot(dataRoot, r.botId);
    if (!bot) {
      endRun(runId, "bot no longer exists");
      onChange(r.botId);
      return Promise.resolve();
    }
    store.unparkRun(db, runId);
    return begin(r, { ...row, status: "running" }, bot, message, true);
  }

  /** A wait of a run closed. A parked run whose last request was answered resumes with every answer of the park in one message. */
  function waitClosed(w: Wait) {
    if (w.runId === null) return;
    const row = store.getRun(db, w.runId);
    // A run still in its turn collects the answer when the turn ends; an ended or deleted run has nobody to tell.
    if (row?.status !== "waiting") return;
    if (w.state === "expired") return expire(row.id);
    const pending = waits.ofRun(row.id);
    if (pending.some((p) => p.state === "open")) return;
    const message = waits.resultText(pending);
    waits.delivered(pending);
    resume(row.id, message).catch((e: Error) =>
      console.error(`[routines] resume ${row.id} failed: ${e.message}`),
    );
  }

  /**
   * A wait of the run went unanswered for 24 hours: the run fails with "approval expired", whatever started it. The bot is told
   * that nothing was approved, in a message of its own session; its reply is a chat message, not the run's output. The single
   * place a run leaves `waiting` for `failed` by time.
   */
  function expire(runId: string) {
    const row = store.getRun(db, runId);
    const lapsed = waits.ofRun(runId).filter((w) => w.state === "expired");
    if (!row || !lapsed.length || !endRun(runId, "approval expired")) return;
    const r = store.getRoutine(db, row.routineId);
    if (r) {
      void (async () => {
        await deps.notice(r.botId, `Routine "${r.name}" failed: approval expired`);
        await deps.deliver(r.botId, waits.resultText(lapsed));
      })().catch((e: Error) =>
        console.error(`[routines] telling ${r.botId} about the expired run failed: ${e.message}`),
      );
      onChange(r.botId);
    }
  }

  function reconcile() {
    const n = now();
    // A run the last process left `running` has no turn any more; what it still asked the owner can never reach it.
    for (const id of store.interruptStaleRuns(
      db,
      n,
      [...running.values()].map((e) => e.runId),
    ))
      waits.cancelRun(id, "the app stopped during the run");
    for (const r of store.listActiveRoutines(db)) {
      const last = r.lastScheduledFor ?? r.createdAt;
      const inWindow = latestOccurrence(r.schedule, Math.max(last, n - WINDOW_MS), n);
      if (inWindow !== null && r.catchUp) {
        void fire(r.id);
        continue;
      }
      const missed =
        inWindow ??
        (hasOccurrence(r.schedule, last, n - WINDOW_MS)
          ? (latestOccurrence(r.schedule, last, n - WINDOW_MS) ?? nextOccurrence(r.schedule, last))
          : null);
      if (missed === null || !store.claimOccurrence(db, r.id, missed)) continue;
      skip(r, missed, "missed while offline");
      if (r.schedule.kind === "once") store.deactivateRoutine(db, r.id, n);
    }
  }

  function view(r: RoutineRecord): Routine {
    const { lastScheduledFor, ...rest } = r;
    const s = r.schedule;
    const pending = s.kind === "cron" || lastScheduledFor === null;
    return {
      ...rest,
      nextRunAt: r.active && pending ? nextOccurrence(s, now()) : null,
      lastRun: store.waitingRun(db, r.id) ?? store.lastRun(db, r.id),
      running: running.has(r.id),
    };
  }

  async function removeRoutine(id: string): Promise<void> {
    const r = require(id);
    disarm(id);
    const e = running.get(id);
    if (e) {
      e.removed = true;
      e.stop?.("routine deleted");
      await e.done;
    }
    const unfinished = store.unfinishedRunIds(db, id);
    store.deleteRoutine(db, id);
    for (const runId of unfinished) waits.cancelRun(runId, "the routine was deleted");
    onChange(r.botId);
  }

  return {
    /** Reconcile downtime, then arm every active routine. */
    start() {
      reconcile();
      for (const r of store.listActiveRoutines(db)) arm(r);
    },

    /** Shutdown: stop all jobs and close running threads; their rows are reconciled on next start. */
    stop() {
      for (const id of jobs.keys()) disarm(id);
      for (const e of running.values()) e.stop?.("shutdown");
    },

    list(botId: string): Routine[] {
      return store.listRoutines(db, botId).map(view);
    },

    /** The name of the routine a run belongs to; undefined when the run or its routine is gone. */
    nameOfRun(runId: string): string | undefined {
      const run = store.getRun(db, runId);
      return run && store.getRoutine(db, run.routineId)?.name;
    },

    get(id: string): Routine {
      return view(require(id));
    },

    create(botId: string, input: RoutineInput): Routine {
      if (!getBot(dataRoot, botId)) throw new NotFound("no such bot");
      const t = now();
      const r: RoutineRecord = {
        id: randomUUID(),
        botId,
        name: input.name,
        instruction: input.instruction,
        schedule: input.schedule,
        active: input.active ?? true,
        catchUp: input.catchUp ?? true,
        lastScheduledFor: null,
        createdAt: t,
        updatedAt: t,
      };
      store.insertRoutine(db, r);
      arm(r);
      onChange(botId);
      return view(r);
    },

    update(id: string, patch: RoutinePatch): Routine {
      const old = require(id);
      const t = now();
      const r: RoutineRecord = {
        ...old,
        ...patch,
        active: patch.active ?? old.active,
        catchUp: patch.catchUp ?? old.catchUp,
        updatedAt: t,
      };
      // Occurrences before an edit or while paused are not "missed": move the claim baseline to now.
      const rescheduled =
        patch.schedule !== undefined &&
        JSON.stringify(patch.schedule) !== JSON.stringify(old.schedule);
      if (rescheduled) r.lastScheduledFor = r.schedule.kind === "once" ? null : t;
      else if (r.active && !old.active && r.schedule.kind === "cron")
        r.lastScheduledFor = Math.max(old.lastScheduledFor ?? 0, t);
      store.saveRoutine(db, r);
      arm(r);
      onChange(r.botId);
      return view(r);
    },

    remove: removeRoutine,

    /** A bot being deleted: stops its running routine turns and removes every routine and run it has. */
    async removeBot(botId: string): Promise<void> {
      for (const r of store.listRoutines(db, botId)) await removeRoutine(r.id);
    },

    testRun(id: string): RoutineRun {
      const r = require(id);
      if (running.has(id)) throw new Conflict("routine is already running");
      if (store.waitingRun(db, id)) throw new Conflict("routine is waiting for you");
      return run(r, "manual", null).row;
    },

    /**
     * Runs a parked run's session on with `message` (the owner's answers) as its next turn, in the bot's chat when it has one and
     * headless otherwise; resolves when the run ends or parks again. Rejects when the run is not waiting.
     */
    resume,

    /** Fails the run for a wait that went unanswered for 24 hours ("approval expired") and tells the bot; nothing happens when no wait of it expired. */
    expire,

    /** The owner's side of a human wait closed (the answer, an expiry, a cancel): resumes or expires the run it belongs to. */
    waitClosed,

    /** The bot's session ended (a new session): its parked runs fail with "session ended while waiting for you" and their waits are cancelled. */
    sessionEnded(botId: string) {
      for (const run of store.waitingRunsOfBot(db, botId))
        if (endRun(run.id, "session ended while waiting for you")) onChange(botId);
    },

    runs(id: string, before = Number.MAX_SAFE_INTEGER, limit = 20): RoutineRun[] {
      require(id);
      return store.listRuns(db, id, before, Math.min(Math.max(limit, 1), 100));
    },

    /** The next three times a schedule would fire, for the editor's preview. */
    preview(schedule: Schedule): number[] {
      return nextOccurrences(schedule, now(), 3);
    },
  };
}

export type Routines = ReturnType<typeof createRoutines>;
