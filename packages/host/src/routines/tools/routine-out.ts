import type { Routine, RunStatus } from "@claudebot/contract/events";

import type { RoutinesToolContext } from "./context.ts";

/** A routine as a bot reads it: snake_case, ISO UTC times, and no run output (it can be long and holds text from outside). */
export type RoutineOut = {
  id: string;
  name: string;
  instruction: string;
  schedule: { kind: "cron"; expr: string; tz: string } | { kind: "once"; at: string };
  active: boolean;
  catch_up: boolean;
  next_runs: string[];
  running: boolean;
  last_run: { status: RunStatus; started_at: string; error: string | null } | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

export function routineOut(ctx: Pick<RoutinesToolContext, "routines">, r: Routine): RoutineOut {
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    schedule:
      r.schedule.kind === "cron"
        ? { kind: "cron", expr: r.schedule.expr, tz: r.schedule.tz }
        : { kind: "once", at: iso(r.schedule.at) },
    active: r.active,
    catch_up: r.catchUp,
    next_runs: r.nextRunAt === null ? [] : ctx.routines.preview(r.schedule).map(iso),
    running: r.running,
    last_run: r.lastRun && {
      status: r.lastRun.status,
      started_at: iso(r.lastRun.startedAt),
      error: r.lastRun.error,
    },
  };
}
