import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatHandoffUpdate } from "../format.ts";
import { openHandoffFor } from "./access.ts";
import { showSent } from "./card.ts";
import type { BotsToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";

export function registerCancelHandoff(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "cancel_handoff",
    {
      description: "Cancel a handoff you made. The assignee is told to stop.",
      inputSchema: {
        handoff_id: z.string().describe("Id returned by hand_off"),
        reason: z.string().describe("Why you cancel"),
      },
    },
    ({ handoff_id, reason }) => {
      const access = openHandoffFor(ctx, handoff_id, "requester");
      if ("error" in access) return access.error;
      const h = ctx.handoffs.transition(handoff_id, {
        senderId: ctx.botId,
        kind: "cancel",
        text: reason,
        status: "canceled",
      });
      ctx.deliver(
        h.assigneeId,
        formatHandoffUpdate({
          id: h.id,
          senderName: ctx.botName(ctx.botId) ?? "A bot",
          status: h.status,
          text: `Canceled, stop work on this handoff. ${reason}`,
        }),
      );
      showSent(ctx, h, reason);
      return jsonResult({ handoff_id: h.id, status: h.status });
    },
  );
}
