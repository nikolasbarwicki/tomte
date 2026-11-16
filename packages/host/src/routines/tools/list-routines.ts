import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RoutinesToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";
import { routineOut } from "./routine-out.ts";

export function registerListRoutines(mcp: McpServer, ctx: RoutinesToolContext) {
  mcp.registerTool(
    "list_routines",
    {
      description:
        "List your own routines, oldest first: id, name, instruction, schedule, whether it is active, the next run times, whether it is running and its last run. Also returns the current time. Works in scheduled runs too.",
    },
    () =>
      jsonResult({
        now: new Date(ctx.now()).toISOString(),
        routines: ctx.routines.list(ctx.botId).map((r) => routineOut(ctx, r)),
      }),
  );
}
