import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatHandoffUpdate } from "../format.ts";
import { openHandoffFor } from "./access.ts";
import { showSent } from "./card.ts";
import type { BotsToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";

export function registerHandoffMessage(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "handoff_message",
    {
      description:
        "Send a message to the other bot of an open handoff, to ask or answer something. It arrives as a new message. Sent by the assignee the handoff becomes input-required; sent by the requester it becomes working.",
      inputSchema: {
        handoff_id: z.string().describe("Id from the handoff message"),
        text: z.string().describe("The message"),
      },
    },
    ({ handoff_id, text }) => {
      const access = openHandoffFor(ctx, handoff_id, "party");
      if ("error" in access) return access.error;
      const fromAssignee = access.handoff.assigneeId === ctx.botId;
      const h = ctx.handoffs.transition(handoff_id, {
        senderId: ctx.botId,
        kind: "message",
        text,
        status: fromAssignee ? "input-required" : "working",
      });
      ctx.deliver(
        fromAssignee ? h.requesterId : h.assigneeId,
        formatHandoffUpdate({
          id: h.id,
          senderName: ctx.botName(ctx.botId) ?? "A bot",
          status: h.status,
          text,
        }),
      );
      showSent(ctx, h, text);
      return jsonResult({ handoff_id: h.id, status: h.status });
    },
  );
}
