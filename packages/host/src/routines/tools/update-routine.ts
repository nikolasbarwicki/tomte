import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NotFound } from "../../platform/errors.ts";
import { RoutinePatch } from "../input.ts";
import type { RoutinesToolContext } from "./context.ts";
import { UNATTENDED_REFUSAL, firstIssue } from "./guards.ts";
import { errorResult, jsonResult } from "./result.ts";
import { routineOut } from "./routine-out.ts";
import { ScheduleArg, routineFields } from "./schedule-arg.ts";

const MAX_NAME_LENGTH = 80;
const MAX_INSTRUCTION_BYTES = 8 * 1024;
const utf8 = new TextEncoder();

export function registerUpdateRoutine(mcp: McpServer, ctx: RoutinesToolContext) {
  mcp.registerTool(
    "update_routine",
    {
      description:
        "Change one of your own routines: any of its name, instruction, schedule, catch_up and active, at least one. Pause a routine with active false and resume it with active true; there is no delete tool. An edit applies from the next occurrence. Pausing does not stop a run already in progress, and a run that is waiting for the owner is not cancelled either. Returns the routine, its next run times and the current time. Not available in scheduled runs.",
      inputSchema: {
        routine_id: z.string().describe("The id from list_routines or create_routine"),
        name: z
          .string()
          .max(MAX_NAME_LENGTH)
          .optional()
          .describe("New name, at most 80 characters"),
        instruction: z
          .string()
          .refine((s) => utf8.encode(s).length <= MAX_INSTRUCTION_BYTES, {
            message: "must be at most 8 KiB",
          })
          .optional()
          .describe("New self-contained instruction, at most 8 KiB"),
        schedule: ScheduleArg.optional(),
        catch_up: z
          .boolean()
          .optional()
          .describe(
            "Run once, up to 12 hours late, when the app was offline at the scheduled time",
          ),
        active: z.boolean().optional().describe("False pauses the routine, true resumes it"),
      },
    },
    ({ routine_id, ...args }) => {
      if (ctx.unattended(ctx.botId)) return errorResult(UNATTENDED_REFUSAL);
      const found = find(ctx, routine_id);
      if (!found) return errorResult("no such routine");
      const fields = routineFields(args);
      if (Object.keys(fields).length === 0) return errorResult("nothing to change");
      const patch = RoutinePatch.safeParse(fields);
      if (!patch.success) return errorResult(firstIssue(patch.error));
      const routine = ctx.routines.update(found.id, patch.data);
      return jsonResult({
        now: new Date(ctx.now()).toISOString(),
        routine: routineOut(ctx, routine),
      });
    },
  );
}

/** The caller's own routine, or nothing: an unknown id and another bot's id look the same, so ids are not revealed. */
function find(ctx: RoutinesToolContext, id: string) {
  try {
    const r = ctx.routines.get(id);
    return r.botId === ctx.botId ? r : undefined;
  } catch (e) {
    if (e instanceof NotFound) return undefined;
    throw e;
  }
}
