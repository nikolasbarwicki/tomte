import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { RoutineInput } from "../input.ts";
import type { RoutinesToolContext } from "./context.ts";
import { UNATTENDED_REFUSAL, firstIssue } from "./guards.ts";
import { errorResult, jsonResult } from "./result.ts";
import { routineOut } from "./routine-out.ts";
import { ScheduleArg, routineFields } from "./schedule-arg.ts";

const MAX_ROUTINES_PER_BOT = 20;
const MAX_NAME_LENGTH = 80;
const MAX_INSTRUCTION_BYTES = 8 * 1024;
const utf8 = new TextEncoder();

export function registerCreateRoutine(mcp: McpServer, ctx: RoutinesToolContext) {
  mcp.registerTool(
    "create_routine",
    {
      description:
        "Create a routine for yourself: a saved instruction that runs on a schedule with nobody watching. It shows up in the owner's Routines panel at once and runs under your own tool approvals. Returns the routine, its next run times and the current time. Not available in scheduled runs.",
      inputSchema: {
        name: z.string().max(MAX_NAME_LENGTH).describe("Short name, at most 80 characters"),
        instruction: z
          .string()
          .refine((s) => utf8.encode(s).length <= MAX_INSTRUCTION_BYTES, {
            message: "must be at most 8 KiB",
          })
          .describe(
            "Self-contained instruction the run follows, at most 8 KiB: the goal, where to look, what to produce, how to end",
          ),
        schedule: ScheduleArg,
        catch_up: z
          .boolean()
          .optional()
          .describe(
            "Run once, up to 12 hours late, when the app was offline at the scheduled time. Default true",
          ),
        active: z.boolean().optional().describe("Start paused when false. Default true"),
      },
    },
    (args) => {
      if (ctx.unattended(ctx.botId)) return errorResult(UNATTENDED_REFUSAL);
      if (ctx.routines.list(ctx.botId).length >= MAX_ROUTINES_PER_BOT)
        return errorResult(
          `you already have ${MAX_ROUTINES_PER_BOT} routines, the most a bot may have; ask the owner to delete one in the Routines panel`,
        );
      const input = RoutineInput.safeParse(routineFields(args));
      if (!input.success) return errorResult(firstIssue(input.error));
      const routine = ctx.routines.create(ctx.botId, input.data);
      return jsonResult({
        now: new Date(ctx.now()).toISOString(),
        routine: routineOut(ctx, routine),
      });
    },
  );
}
