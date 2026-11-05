import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserToolContext } from "../tools.ts";
import { errorResult, textResult } from "./result.ts";

export const UNATTENDED_MESSAGE = "not available in unattended runs; report the login wall or CAPTCHA in your result instead";

export function registerTakeoverTools(mcp: McpServer, ctx: BrowserToolContext) {
  mcp.registerTool(
    "browser_request_takeover",
    {
      description:
        "Ask the user to handle something in your browser that you cannot: a CAPTCHA, a two-factor code, a passkey, a login you cannot complete. Returns at once; end your turn after calling it. The user's answer arrives as a new message.",
      inputSchema: { reason: z.string().min(1).max(500).describe("What the user needs to do, in one sentence") },
    },
    ({ reason }) => {
      if (ctx.unattended()) return errorResult(UNATTENDED_MESSAGE);
      const wait = ctx.takeover.request(ctx.botId, reason);
      return textResult(
        JSON.stringify({ ...wait, instruction: "The user was asked to take over your browser. End your turn now without further browser calls; their answer will arrive as a new message." }),
      );
    },
  );
}
