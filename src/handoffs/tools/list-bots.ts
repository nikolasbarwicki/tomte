import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BotsToolContext } from "./context.ts";
import { jsonResult } from "./result.ts";

export function registerListBots(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "list_bots",
    { description: "List the other bots you can hand work to: id, name, description (its purpose) and status (idle or working)." },
    () => jsonResult(ctx.cards().filter((c) => c.id !== ctx.botId)),
  );
}
