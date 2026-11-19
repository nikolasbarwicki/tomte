import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, Routine, RoutineRun, RunTrigger, Schedule } from "@tomte/contract/events";
import { UPDATING } from "@tomte/contract/update";

import {
  currentSession,
  getBot,
  openThread,
  touchBot,
  type HostDelegate,
  TurnError,
  type Thread,
  type ThreadEnv,
  type TurnUsage,
} from "../bots/index.ts";
import type { Events } from "../events/index.ts";
import { NotFound } from "../platform/errors.ts";
import { waitTitle, type Wait, type Waits } from "../waits/index.ts";
import { RoutineInput, RoutinePatch } from "./input.ts";
import { parkingDelegate } from "./parking.ts";
import { describeCap, startRunClock, type RunClock } from "./run-clock.ts";
import {
  WINDOW_MS,
  hasOccurrence,
  latestOccurrence,
  nextOccurrence,
  nextOccurrences,
} from "./schedule.ts";
import * as store from "./store.ts";
import type { RoutineRecord } from "./store.ts";

export { parkingDelegate };
export {
  ROUTINES_ENDPOINT_PATH,
  ROUTINES_INSTRUCTIONS,
  ROUTINES_SERVER_NAME,
  createRoutinesEndpoint,
  type RoutinesEndpoint,
} from "./endpoint.ts";

export { RoutineInput, RoutinePatch };

export class Conflict extends Error {}

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
  /**
   * The session id of a double-loop bot's run, which has a session of its own: the bot's front keeps its conversation, and a
   * routine run never enters it. Undefined for a standard bot, whose run writes the bot's current session.
   */
  ownSession?: string;
};

/** What a routine turn ends in: the final text and what the turn used (null when unknown). */
export interface RoutineTurnResult {
  text: string;
  usage: TurnUsage | null;
}

/** One agent turn of a run, in the bot's chat session or, for a double-loop bot, in the run's own session; `done` resolves to its result, `stop` ends it early (rejecting `done`). A failed turn rejects with a `TurnError` that carries its usage. */
export type Executor = (job: RoutineJob) => {
  done: Promise<RoutineTurnResult>;
  stop: (reason: string) => void;
};

/**
 * A run that reached a terminal status, as the row now stands. `expired` holds the titles of the waits whose 24 hours ran out
 * when that is why it failed ("approval expired"), so the cause is not read back from the error text; it is empty otherwise.
 */
export type RunEnd = { run: RoutineRun; routine: RoutineRecord; expired: string[] };

/** A run in progress; `removed` marks one stopped by `remove()`, whose row the cascade already owns. */
type LiveRun = {
  runId: string;
  stop?: (reason: string) => void;
  done: Promise<void>;
  removed?: boolean;
  /** Set when the run's time cap ran out: what the run records as its error, whatever the stopped executor throws. */
  expired?: string;
  clock?: RunClock;
  /** Rejects with the limit message when the cap runs out, so a turn that ignores `stop` still ends the run. */
  expiry: { promise: Promise<never>; reject(reason: Error): void };
};

const LATE_NOTE_MS = 15 * 60_000;
const DEFAULT_RUN_CAP_MS = 30 * 60_000;
/** setTimeout's delay is a signed 32-bit int; longer waits re-arm in steps. */
const MAX_TIMEOUT_MS = 2_147_000_000;
/** A routine is paused when this many runs in a row, counting only those that succeeded or failed, failed. */
const FAILURES_TO_PAUSE = 5;
/** The key of a routine's pause notice, which `<routine id>:<failed run id>` follows: a second pause of the routine is a new notice. */
const PAUSE_NOTICE = "routine-paused:";

/** Runs a routine turn without the UI, for a bot that is not open, or whose run has a session of its own. `delegate` answers what the bot asks during the turn. */
export function runHeadless(
  env: ThreadEnv,
  { bot, routine, prompt, ownSession }: RoutineJob,
  delegate: HostDelegate,
): ReturnType<Executor> {
  let thread: Thread | undefined;
  let stopped: string | undefined;
  const done = (async () => {
    const sessionId = ownSession ?? currentSession(bot);
    const resume = sessionId !== undefined && !!(await getSessionInfo(sessionId, { dir: env.cwd }));
    if (stopped) throw new Error(stopped);
    thread = openThread(env, bot, {
      resume,
      ...(ownSession !== undefined && { sessionId: ownSession }),
      delegate,
      log: (l) => console.error(`[routine ${routine.name}] ${l}`),
    });
    touchBot(env.dataRoot, bot);
    try {
      const { text, usage } = await thread.send(prompt);
      return { text, usage };
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
    'No human is watching this run, but you can reach the owner: a tool that needs approval, and the ask_user tool, send the request to the owner and park this run until they answer. The answer arrives later as a message in this conversation. After sending such a request, end your turn; do not guess, retry or wait. Otherwise carry out the instruction below on your own. A source you cannot use (a page that asks you to sign in, a page that stays behind bot protection) does not fail the run: skip it and add a line "Unavailable: <source> (<reason>)" to your summary for each one. Save anything you produce in your files folder. End with a short summary (at most 5 lines) of what you did and what the user should know.',
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
  /** Starts a cron job that calls `tick` at every occurrence of `expr` in `tz`; Bun's, unless a test drives the ticks itself. */
  cron?: (expr: string, tz: string, tick: () => void) => { stop(): void };
  execute: Executor;
  /** How long a run may work before it fails; time parked at a human wait does not count. */
  runCapMs?: number;
  onChange: (botId: string) => void;
  /** The human waits of a run: what it is waiting for, what the owner answered, and the cancelling of what an ended run left open. */
  waits: Pick<Waits, "ofRun" | "cancelRun" | "resultText" | "delivered">;
  /** Shows the owner a line in the bot's chat. */
  notice(botId: string, text: string): Promise<void>;
  /** Sends a host message into the bot's session through the normal send path (queued while the bot is busy). */
  deliver(botId: string, text: string): Promise<void>;
  /**
   * Called once when a run reaches `succeeded`, `failed` or `interrupted`, after its row is final: when a turn ends it, when a parked run
   * resumes and ends, when a park expires, and for a run the last process left behind (found by `start()`). Not for a skipped run, and not
   * for a run stopped by `remove()` or by shutdown (the next start reports it as interrupted). A throw is logged and changes nothing.
   */
  onRunEnded(end: RunEnd): void;
  /** The host's own needs-you items: a paused routine tells its owner through one, and resuming it closes it. */
  events: Pick<Events, "notice" | "resolveNotices">;
  /** While it is closed (the host is draining for an update) no scheduled run starts and a manual run is refused; open by default. `catchUp()` follows when it reopens. */
  gate?: { closed(): boolean };
}) {
  const { db, dataRoot, onChange, execute, waits } = deps;
  const now = deps.now ?? Date.now;
  const cron = deps.cron ?? ((expr, tz, tick) => Bun.cron(expr, tick, { tz }));
  const jobs = new Map<string, { stop: () => void }>();
  const running = new Map<string, LiveRun>();
  let stopping = false;
  const runCapMs = deps.runCapMs ?? DEFAULT_RUN_CAP_MS;

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
      const job = cron(s.expr, s.tz, () => void fire(r.id));
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
      usage: null,
      costUsd: null,
      parkedMs: 0,
    });
    onChange(r.botId);
  }

  /** Single path for scheduled and caught-up runs; spurious or duplicate wakes are no-ops. */
  async function fire(id: string) {
    try {
      const r = store.getRoutine(db, id);
      if (!r?.active) return;
      // The occurrence stays unclaimed, so after the restart (or `catchUp()`) it follows the routine's `catchUp` setting.
      if (deps.gate?.closed()) return;
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
      if (store.waitingRun(db, id, now())) return skip(r, t, "previous run is waiting for you");
      await run(r, "schedule", t).done;
    } catch (e) {
      console.error(`[routines] fire ${id} failed: ${(e as Error).message}`);
    }
  }

  /** Reports a run that just reached a terminal status; nothing when its routine is gone. */
  function ended(row: RoutineRun, expired: string[] = []) {
    const routine = store.getRoutine(db, row.routineId);
    if (!routine) return;
    try {
      deps.onRunEnded({ run: row, routine, expired });
    } catch (e) {
      console.error(`[routines] reporting run ${row.id} failed: ${(e as Error).message}`);
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
      sessionId: bot
        ? bot.chatMode === "double_loop"
          ? randomUUID()
          : (currentSession(bot) ?? null)
        : null,
      output: null,
      error: bot ? null : "bot no longer exists",
      startedAt,
      finishedAt: bot ? null : startedAt,
      usage: null,
      costUsd: null,
      parkedMs: 0,
    };
    store.insertRun(db, row);
    if (!bot) {
      ended(row);
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
  function begin(
    r: RoutineRecord,
    row: RoutineRun,
    bot: Bot,
    first: string,
    resumed: boolean,
    usedMs = 0,
  ) {
    const entry: LiveRun = {
      runId: row.id,
      done: Promise.resolve(),
      expiry: Promise.withResolvers(),
    };
    entry.expiry.promise.catch(() => {});
    entry.clock = startRunClock(runCapMs, () => expireRun(entry), usedMs);
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
      const ownSession = bot.chatMode === "double_loop" ? (row.sessionId ?? undefined) : undefined;
      for (;;) {
        const job = execute({
          bot,
          routine: r,
          prompt: message,
          runId: row.id,
          trigger: row.trigger,
          resumed: isResume,
          ...(ownSession !== undefined && { ownSession }),
        });
        entry.stop = job.stop;
        // Usage is booked whenever the turn settles, even after the run cap has already ended the run.
        void job.done.then(
          (r) => r.usage && store.addRunUsage(db, row.id, r.usage),
          (e: unknown) =>
            e instanceof TurnError && e.usage && store.addRunUsage(db, row.id, e.usage),
        );
        const { text } = await Promise.race([job.done, entry.expiry.promise]);
        if (entry.removed) return;
        if (entry.expired) throw new Error(entry.expired);
        const pending = waits.ofRun(row.id);
        if (pending.some((w) => w.state === "open")) {
          // The park starts here: the clock stops and the active time used so far is kept for the resume.
          entry.clock?.pause();
          store.parkRun(db, row.id, now(), entry.clock?.activeMs() ?? 0);
          return;
        }
        if (pending.some((w) => w.state === "expired")) return expire(row.id);
        if (pending.length === 0) {
          if (store.finishRun(db, row.id, "succeeded", { output: text, finishedAt: now() }))
            ended(store.getRun(db, row.id, now())!);
          return;
        }
        message = waits.resultText(pending);
        waits.delivered(pending);
        isResume = true;
      }
    } catch (e) {
      // A run stopped by shutdown keeps its `running` row: the next start finds it and reports it as interrupted.
      if (entry.removed || stopping) return;
      endRun(row.id, entry.expired ?? (e as Error).message);
    } finally {
      entry.clock?.clear();
      if (running.get(r.id) === entry) running.delete(r.id);
      onChange(r.botId);
    }
  }

  /** Fails a run that has not ended and cancels what it still waits for, telling nobody (but `onRunEnded`); false when the run had ended. */
  function endRun(runId: string, error: string, expired: string[] = []): boolean {
    if (!store.finishRun(db, runId, "failed", { error, finishedAt: now() })) return false;
    pauseAfterFailures(runId);
    waits.cancelRun(runId, error);
    ended(store.getRun(db, runId, now())!, expired);
    return true;
  }

  /** The cap ran out: the run fails with the limit, not with what stopping its executor throws. */
  function expireRun(entry: LiveRun) {
    if (entry.removed || entry.expired) return;
    entry.expired = `run exceeded the ${describeCap(runCapMs)} time limit`;
    try {
      entry.stop?.(entry.expired);
    } catch (e) {
      console.error(
        `[routines] stopping the expired run ${entry.runId} failed: ${(e as Error).message}`,
      );
    }
    entry.expiry.reject(new Error(entry.expired));
  }

  /** A failed run that completes a streak of failures pauses its routine and tells the owner, who need not have the bot open. */
  function pauseAfterFailures(runId: string) {
    const row = store.getRun(db, runId, now());
    const r = row && store.getRoutine(db, row.routineId);
    if (!r?.active || !getBot(dataRoot, r.botId)) return;
    const last = store.lastOutcomes(db, r.id, FAILURES_TO_PAUSE);
    if (last.length < FAILURES_TO_PAUSE || last.some((o) => o.status !== "failed")) return;
    if (!store.pauseRoutine(db, r.id, "failures", now())) return;
    disarm(r.id);
    deps.events.notice(r.botId, {
      key: `${PAUSE_NOTICE}${r.id}:${runId}`,
      title: `${r.name} paused after ${FAILURES_TO_PAUSE} failed runs`,
      ...(last[0]?.error != null && { body: last[0].error }),
    });
    onChange(r.botId);
  }

  /** A parked run's answers are all in: runs its session on with them. The single place a run leaves `waiting` for `running`. */
  async function resume(runId: string, message: string): Promise<void> {
    const row = store.getRun(db, runId, now());
    if (row?.status !== "waiting") throw new Conflict("run is not waiting");
    const r = require(row.routineId);
    const bot = getBot(dataRoot, r.botId);
    if (!bot) {
      endRun(runId, "bot no longer exists");
      onChange(r.botId);
      return Promise.resolve();
    }
    // The park ends here: its time joins the run's parked time and the clock goes on from the active time used before it.
    const usedMs = store.unparkRun(db, runId, now()) ?? 0;
    return begin(r, { ...row, status: "running" }, bot, message, true, usedMs);
  }

  /** A wait of a run closed. A parked run whose last request was answered resumes with every answer of the park in one message. */
  function waitClosed(w: Wait) {
    if (w.runId === null) return;
    const row = store.getRun(db, w.runId, now());
    // A run still in its turn collects the answer when the turn ends; an ended or deleted run has nobody to tell.
    if (row?.status !== "waiting") return;
    if (w.state === "expired") return expire(row.id);
    resumeIfAnswered(row.id);
  }

  /**
   * Resumes a parked run whose requests are all answered, with every answer of the park in one message. While the gate is closed
   * nothing starts: the answers stay stored and undelivered, and `resumeAnswered` picks the run up when the gate reopens or the
   * host starts again.
   */
  function resumeIfAnswered(runId: string) {
    if (deps.gate?.closed()) return;
    const pending = waits.ofRun(runId);
    if (pending.some((p) => p.state === "open")) return;
    const message = waits.resultText(pending);
    waits.delivered(pending);
    resume(runId, message).catch((e: Error) =>
      console.error(`[routines] resume ${runId} failed: ${e.message}`),
    );
  }

  /** Parked runs that were answered while nothing could start (an update draining or applying) go on now. */
  function resumeAnswered() {
    for (const run of store.waitingRuns(db, now()))
      if (waits.ofRun(run.id).some((w) => w.state === "answered")) resumeIfAnswered(run.id);
  }

  /**
   * A wait of the run went unanswered for 24 hours: the run fails with "approval expired", whatever started it. A standard bot
   * is told that nothing was approved, in a message of its own session; its reply is a chat message, not the run's output. A
   * double-loop bot's run has a session of its own that nothing continues, and its front is never told: the Routines panel
   * shows the failure. The single place a run leaves `waiting` for `failed` by time.
   */
  function expire(runId: string) {
    const row = store.getRun(db, runId, now());
    const lapsed = waits.ofRun(runId).filter((w) => w.state === "expired");
    if (!row || !lapsed.length || !endRun(runId, "approval expired", lapsed.map(waitTitle))) return;
    const r = store.getRoutine(db, row.routineId);
    if (r) {
      if (getBot(dataRoot, r.botId)?.chatMode !== "double_loop")
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
    for (const run of store.interruptStaleRuns(
      db,
      n,
      [...running.values()].map((e) => e.runId),
    )) {
      waits.cancelRun(run.id, "the app stopped during the run");
      ended(run);
    }
    catchUpDue();
    resumeAnswered();
  }

  /** Occurrences that came due while nothing ran (the host was down, or draining for an update): each is fired or recorded as missed, by its routine's `catchUp` setting. */
  function catchUpDue() {
    const n = now();
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
      lastRun: store.waitingRun(db, r.id, now()) ?? store.lastRun(db, r.id, now()),
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
    deps.events.resolveNotices(r.botId, `${PAUSE_NOTICE}${id}:`);
    onChange(r.botId);
  }

  const api = {
    /** Reconcile downtime, then arm every active routine. */
    start() {
      reconcile();
      for (const r of store.listActiveRoutines(db)) arm(r);
    },

    /** The gate reopened: what came due while it was closed is fired or recorded as missed, as after a restart. */
    catchUp() {
      catchUpDue();
      resumeAnswered();
    },

    /** Shutdown: stop all jobs and close running threads; their rows are reconciled on next start. */
    stop() {
      stopping = true;
      for (const id of jobs.keys()) disarm(id);
      for (const e of running.values()) {
        e.clock?.clear();
        e.stop?.("shutdown");
      }
    },

    list(botId: string): Routine[] {
      return store.listRoutines(db, botId).map(view);
    },

    /** The name of the routine a run belongs to; undefined when the run or its routine is gone. */
    nameOfRun(runId: string): string | undefined {
      const run = store.getRun(db, runId, now());
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
        pausedReason: null,
        catchUp: input.catchUp ?? true,
        notifyResult: input.notifyResult ?? false,
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
        notifyResult: patch.notifyResult ?? old.notifyResult,
        updatedAt: t,
      };
      // Only the switch moves a routine out of a pause the host chose: an edit of the instruction or the schedule keeps it.
      if (r.active || old.active) r.pausedReason = null;
      // Occurrences before an edit or while paused are not "missed": move the claim baseline to now.
      const rescheduled =
        patch.schedule !== undefined &&
        JSON.stringify(patch.schedule) !== JSON.stringify(old.schedule);
      if (rescheduled) r.lastScheduledFor = r.schedule.kind === "once" ? null : t;
      else if (r.active && !old.active && r.schedule.kind === "cron")
        r.lastScheduledFor = Math.max(old.lastScheduledFor ?? 0, t);
      store.saveRoutine(db, r);
      // Switching a routine back on means "try again": failures before it no longer count toward a pause.
      if (r.active && !old.active) store.restartFailureCount(db, r.id, t);
      if (old.pausedReason === "failures" && r.active)
        deps.events.resolveNotices(r.botId, `${PAUSE_NOTICE}${r.id}:`);
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
      if (deps.gate?.closed()) throw new Conflict(UPDATING);
      if (running.has(id)) throw new Conflict("routine is already running");
      if (store.waitingRun(db, id, now())) throw new Conflict("routine is waiting for you");
      return run(r, "manual", null).row;
    },

    /**
     * Runs a parked run's session on with `message` (the owner's answers) as its next turn, in the bot's chat when it has one and
     * headless otherwise (a double-loop bot's run is always headless, in its own session); resolves when the run ends or parks
     * again. Rejects when the run is not waiting.
     */
    resume,

    /** Fails the run for a wait that went unanswered for 24 hours ("approval expired") and tells the bot; nothing happens when no wait of it expired. */
    expire,

    /** The owner's side of a human wait closed (the answer, an expiry, a cancel): resumes or expires the run it belongs to. */
    waitClosed,

    /** The bot's session ended (a new session): its parked runs fail with "session ended while waiting for you" and their waits are cancelled. */
    sessionEnded(botId: string) {
      for (const run of store.waitingRunsOfBot(db, botId, now()))
        if (endRun(run.id, "session ended while waiting for you")) onChange(botId);
    },

    runs(id: string, before = Number.MAX_SAFE_INTEGER, limit = 20): RoutineRun[] {
      require(id);
      return store.listRuns(db, id, before, Math.min(Math.max(limit, 1), 100), now());
    },

    /** The active routines of bots that exist, with their bot, for what must tell an owner about every routine that is about to stop. */
    active(): { botId: string; name: string }[] {
      return store
        .listActiveRoutines(db)
        .filter((r) => getBot(dataRoot, r.botId))
        .map(({ botId, name }) => ({ botId, name }));
    },

    /** Pauses every active routine of a bot that exists, saying why, and returns them. A run already working finishes; only the schedule is disarmed. */
    pauseAll(
      reason: NonNullable<RoutineRecord["pausedReason"]>,
    ): { botId: string; name: string }[] {
      const t = now();
      const paused: { botId: string; name: string }[] = [];
      for (const r of store.listActiveRoutines(db)) {
        if (!getBot(dataRoot, r.botId) || !store.pauseRoutine(db, r.id, reason, t)) continue;
        disarm(r.id);
        paused.push({ botId: r.botId, name: r.name });
      }
      for (const botId of new Set(paused.map((p) => p.botId))) onChange(botId);
      return paused;
    },

    /** Resumes every routine paused for `reason` the way the owner's switch does (no catch-up of what was missed); returns the bots it touched. */
    resumeByReason(reason: NonNullable<RoutineRecord["pausedReason"]>): string[] {
      const bots = new Set<string>();
      for (const r of store.listPausedFor(db, reason)) {
        api.update(r.id, { active: true });
        bots.add(r.botId);
      }
      return [...bots];
    },

    /** The next three times a schedule would fire, for the editor's preview. */
    preview(schedule: Schedule): number[] {
      return nextOccurrences(schedule, now(), 3);
    },
  };
  return api;
}

export type Routines = ReturnType<typeof createRoutines>;
