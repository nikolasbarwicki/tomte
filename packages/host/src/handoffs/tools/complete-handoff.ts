import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatHandoffUpdate } from "../format.ts";
import { copyHandoffFiles } from "../handoff-files.ts";
import { openHandoffFor } from "./access.ts";
import { showSent } from "./card.ts";
import type { BotsToolContext } from "./context.ts";
import { errorResult, jsonResult } from "./result.ts";

export function registerCompleteHandoff(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "complete_handoff",
    {
      description:
        "Finish a handoff you were given, with your result. The requester receives it as a new message.",
      inputSchema: {
        handoff_id: z.string().describe("Id from the handoff message"),
        result: z.string().describe("The deliverable, as text"),
        files: z
          .array(z.string())
          .optional()
          .describe(
            "Names of files in your files folder to hand over; they are copied into the requester's files folder under handoffs/<handoff id>/",
          ),
      },
    },
    ({ handoff_id, result, files }) => {
      const access = openHandoffFor(ctx, handoff_id, "assignee");
      if ("error" in access) return access.error;
      const copied = files?.length
        ? copyHandoffFiles(
            ctx.filesDir(ctx.botId),
            ctx.filesDir(access.handoff.requesterId),
            handoff_id,
            files,
          )
        : { paths: [] };
      if ("error" in copied)
        return errorResult(`${copied.error}; nothing was copied and the handoff is still open`);
      const text = copied.paths.length
        ? `${result}\n\nFiles copied into your files folder:\n${copied.paths.map((p) => `- ${p}`).join("\n")}`
        : result;
      const h = ctx.handoffs.transition(handoff_id, {
        senderId: ctx.botId,
        kind: "result",
        text,
        status: "completed",
        result,
      });
      ctx.deliver(
        h.requesterId,
        formatHandoffUpdate({
          id: h.id,
          senderName: ctx.botName(ctx.botId) ?? "A bot",
          status: h.status,
          text,
        }),
      );
      showSent(ctx, h, text);
      return jsonResult({
        handoff_id: h.id,
        status: h.status,
        ...(copied.paths.length ? { files: copied.paths } : {}),
      });
    },
  );
}
