import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BotsToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";

export function registerListHandoffs(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "list_handoffs",
    {
      description:
        "List your open handoffs, as requester or assignee: id, role, the other bot, title, status and the last message. Use it to catch up after your context was compacted.",
    },
    () =>
      jsonResult(
        ctx.handoffs.openFor(ctx.botId).map((h) => {
          const requester = h.requesterId === ctx.botId;
          const otherId = requester ? h.assigneeId : h.requesterId;
          const last = ctx.handoffs.messages(h.id).at(-1);
          return {
            handoff_id: h.id,
            role: requester ? "requester" : "assignee",
            other_bot: { id: otherId, name: ctx.botName(otherId) ?? "A bot" },
            title: h.title,
            status: h.status,
            last_message: last && { from: ctx.botName(last.senderId) ?? "A bot", text: last.text },
          };
        }),
      ),
  );
}
