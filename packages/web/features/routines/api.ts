import type { Schedule } from "@tomte/contract/events";

import { act, post } from "@/host/api.ts";

export type RoutineFields = {
  name: string;
  instruction: string;
  schedule: Schedule;
  catchUp: boolean;
  notifyResult: boolean;
};

export const createRoutine = (botId: string, fields: RoutineFields) =>
  post("/api/routines/create", { botId, ...fields });

export const updateRoutine = (id: string, fields: RoutineFields) =>
  post("/api/routines/update", { id, ...fields });

export const setRoutineActive = (id: string, active: boolean) =>
  act("/api/routines/update", { id, active });

export const runRoutine = (id: string) => act("/api/routines/run", { id });

export const deleteRoutine = (id: string) => act("/api/routines/delete", { id });

export const routineRuns = (id: string) => post("/api/routines/runs", { id });

export const previewSchedule = (schedule: Schedule) => post("/api/routines/preview", { schedule });
