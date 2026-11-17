import type { Routine, Schedule } from "@tomte/contract/events";

import type { RoutineInput, RoutinePatch } from "../input.ts";

/** The part of the routines registry the tools use. It is declared here, not imported from `../index.ts`, which re-exports the endpoint. */
export interface RoutinesPort {
  list(botId: string): Routine[];
  /** Throws `NotFound` for an unknown id. */
  get(id: string): Routine;
  create(botId: string, input: RoutineInput): Routine;
  update(id: string, patch: RoutinePatch): Routine;
  /** The next three times a schedule would fire. */
  preview(schedule: Schedule): number[];
}

/** What every routines tool may touch; the caller's id comes from the token and is never an argument. */
export interface RoutinesToolContext {
  botId: string;
  routines: RoutinesPort;
  /** Whether the call comes from a scheduled run (a routine turn or a headless run) right now; checked on every call. */
  unattended(botId: string): boolean;
  now(): number;
}
