import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatHandoff } from "../format.ts";
import { showSent } from "./card.ts";
import type { BotsToolContext } from "./context.ts";
import { handOffRefusal } from "./guards.ts";
import { errorResult, jsonResult } from "./result.ts";

export function registerHandOff(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "hand_off",
    {
      description:
        "Hand a task to another bot. Returns the handoff id at once; the result arrives later as a new message, so report the handoff to the user and stop, or continue with independent work.",
      inputSchema: {
        to: z.string().describe("Id of the bot, from list_bots"),
        title: z.string().describe("Short title of the task"),
        brief: z
          .string()
          .describe("Self-contained brief: goal, context, constraints, deliverable, done when"),
      },
    },
    ({ to, title, brief }) => {
      const assigneeName = ctx.botName(to);
      if (assigneeName === undefined) return errorResult(`no bot with id ${to}; use list_bots`);
      const refusal = handOffRefusal({
        from: ctx.botId,
        to,
        title,
        brief,
        edges: ctx.handoffs.openEdges(),
      });
      if (refusal !== undefined) return errorResult(`handoff refused: ${refusal}`);
      const h = ctx.handoffs.create({ requesterId: ctx.botId, assigneeId: to, title, brief });
      ctx.deliver(
        to,
        formatHandoff({ id: h.id, requesterName: ctx.botName(ctx.botId) ?? "A bot", title, brief }),
      );
      showSent(ctx, h, brief);
      return jsonResult({ handoff_id: h.id, status: h.status });
    },
  );
}
