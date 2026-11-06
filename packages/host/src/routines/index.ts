import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { getSessionInfo, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, Routine, RoutineRun, RunTrigger, Schedule } from "@claudebot/contract/events";
import { z } from "zod";

import {
  Thread,
  botContext,
  currentSession,
  getBot,
  touchBot,
  type HostDelegate,
} from "../bots/index.ts";
import type { HostServersSource, ResolvedCli } from "../harness/index.ts";
import type { IntegrationsSource } from "../integrations/index.ts";
import { NotFound } from "../platform/errors.ts";
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

export type RoutineJob = { bot: Bot; routine: RoutineRecord; prompt: string };

/** One agent turn in the bot's chat session; `done` resolves to the final text, `stop` ends it early (rejecting `done`). */
export type Executor = (job: RoutineJob) => {
  done: Promise<string>;
  stop(reason: string): void;
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

/** Answers a routine's questions and approvals while nobody is watching. */
export const headlessDelegate: HostDelegate = {
  askUser: async () =>
    "No human is available during this scheduled run. Make the most reasonable assumption, state it in your final message, and continue.",
  approve: async (): Promise<PermissionResult> => ({
    behavior: "deny",
    message: "no human is present during a scheduled run",
  }),
};

/** Runs a routine turn in the bot's own session without the UI, for a bot that is not open. */
export function runHeadless(
  cwd: string,
  dataRoot: string,
  cli: ResolvedCli,
  integrations: IntegrationsSource,
  hostServers: HostServersSource,
  { bot, routine, prompt }: RoutineJob,
): ReturnType<Executor> {
  let thread: Thread | undefined;
  let stopped: string | undefined;
  const done = (async () => {
    const ctx = botContext(dataRoot, bot);
    const resume = !!(await getSessionInfo(ctx.sessionId, { dir: cwd }));
    if (stopped) throw new Error(stopped);
    thread = new Thread({
      cli,
      cwd,
      ...ctx,
      resume,
      approveAll: process.env.CLAUDEBOT_ASK_APPROVAL !== "1",
      integrations,
      hostServers: () => hostServers(bot.id),
      delegate: headlessDelegate,
      log: (l) => console.error(`[routine ${routine.name}] ${l}`),
    });
    touchBot(dataRoot, bot);
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
    "No human is watching this run. Carry out the instruction below on your own. Save anything you produce in your files folder. End with a short summary (at most 5 lines) of what you did and what the user should know.",
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
}) {
  const { db, dataRoot, onChange, execute } = deps;
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, { stop(): void }>();
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
      sessionId: bot ? currentSession(bot) : null,
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
    const entry: LiveRun = { runId: row.id, done: Promise.resolve() };
    running.set(r.id, entry);
    onChange(r.botId);
    entry.done = (async () => {
      try {
        const job = execute({
          bot,
          routine: r,
          prompt: prompt(
            r,
            trigger,
            scheduledFor,
            scheduledFor === null ? 0 : startedAt - scheduledFor,
          ),
        });
        entry.stop = job.stop;
        const text = await job.done;
        store.finishRun(db, row.id, "succeeded", { output: text, finishedAt: now() });
      } catch (e) {
        if (entry.removed) return;
        const message = (e as Error).message;
        store.finishRun(db, row.id, "failed", { error: message, finishedAt: now() });
      } finally {
        running.delete(r.id);
        onChange(r.botId);
      }
    })();
    return { row, done: entry.done };
  }

  function reconcile() {
    const n = now();
    store.interruptStaleRuns(
      db,
      n,
      [...running.values()].map((e) => e.runId),
    );
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
      lastRun: store.lastRun(db, r.id),
      running: running.has(r.id),
    };
  }

  return {
    /** Reconcile downtime, then arm every active routine. */
    start() {
      reconcile();
      for (const r of store.listActiveRoutines(db)) arm(r);
    },

    /** Shutdown: stop all jobs and close running threads; their rows are reconciled on next start. */
    stop() {
      for (const id of [...jobs.keys()]) disarm(id);
      for (const e of running.values()) e.stop?.("shutdown");
    },

    list(botId: string): Routine[] {
      return store.listRoutines(db, botId).map(view);
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

    update(id: string, patch: Partial<RoutineInput>): Routine {
      const old = require(id);
      const t = now();
      const r: RoutineRecord = { ...old, ...patch, updatedAt: t };
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

    async remove(id: string): Promise<void> {
      const r = require(id);
      disarm(id);
      const e = running.get(id);
      if (e) {
        e.removed = true;
        e.stop?.("routine deleted");
        await e.done;
      }
      store.deleteRoutine(db, id);
      onChange(r.botId);
    },

    testRun(id: string): RoutineRun {
      const r = require(id);
      if (running.has(id)) throw new Conflict("routine is already running");
      return run(r, "manual", null).row;
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
