import { expect } from "bun:test";

// What the routine tool tests share: the schedule and refusal text they expect, the shape the tools answer with, and the panel's list.
import type { Routine } from "@tomte/contract/events";

import type { HandoffHost } from "./test-host.ts";

export const WEEKDAYS = { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" };
export const UNATTENDED = "scheduled runs cannot create or change routines; ask the user in chat";

/** One routine as `create_routine`, `update_routine` and `list_routines` answer. */
export type RoutineOut = {
  id: string;
  name: string;
  instruction: string;
  schedule: { kind: string; expr?: string; tz?: string; at?: string };
  active: boolean;
  catch_up: boolean;
  next_runs: string[];
};
/** What `create_routine` and `update_routine` answer. */
export type ToolOut = { now: string; routine: RoutineOut };

/** The bot's routines as the Routines panel reads them. */
export async function routinesOf(host: HandoffHost, botId: string) {
  const res = await host.ui("/api/routines/list", { botId });
  expect(res.status).toBe(200);
  return (await res.json()) as Routine[];
}
