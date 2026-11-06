import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatHandoffUpdate } from "../format.ts";
import { openHandoffFor } from "./access.ts";
import { showSent } from "./card.ts";
import type { BotsToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";

export function registerFailHandoff(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "fail_handoff",
    {
      description:
        "Decline a handoff you were given, or give up on it, with the reason. The requester receives the reason as a new message.",
      inputSchema: {
        handoff_id: z.string().describe("Id from the handoff message"),
        reason: z.string().describe("Why you decline or cannot finish"),
      },
    },
    ({ handoff_id, reason }) => {
      const access = openHandoffFor(ctx, handoff_id, "assignee");
      if ("error" in access) return access.error;
      const h = ctx.handoffs.transition(handoff_id, {
        senderId: ctx.botId,
        kind: "failure",
        text: reason,
        status: "failed",
      });
      ctx.deliver(
        h.requesterId,
        formatHandoffUpdate({
          id: h.id,
          senderName: ctx.botName(ctx.botId) ?? "A bot",
          status: h.status,
          text: reason,
        }),
      );
      showSent(ctx, h, reason);
      return jsonResult({ handoff_id: h.id, status: h.status });
    },
  );
}
