import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NEEDS_STEP } from "../login.ts";
import type { BrowserToolContext } from "./context.ts";
import { errorResult, guarded, textResult } from "./result.ts";

export function registerCredentialTools(mcp: McpServer, ctx: BrowserToolContext) {
  mcp.registerTool(
    "browser_credentials",
    {
      description:
        "List the stored credentials you can sign in with, by label and site. Passwords and usernames are never shown.",
      inputSchema: {},
    },
    () => textResult(JSON.stringify(ctx.login.list())),
  );

  mcp.registerTool(
    "browser_login",
    {
      description:
        'Sign in to a site with a stored credential, by its label from browser_credentials. You never see the password. The first use needs the user\'s approval: then this returns {status:"waiting_for_user"} at once and you end your turn; the answer arrives as a new message and you call again.',
      inputSchema: { entry: z.string().min(1).max(200).describe("The credential's label") },
    },
    ({ entry }) =>
      guarded(async () => {
        const r = await ctx.login.login(ctx.botId, ctx.browser, ctx.page, entry);
        switch (r.status) {
          case "waiting_for_user":
            return textResult(
              JSON.stringify({
                ...r,
                instruction:
                  "The user was asked to approve this sign-in. End your turn now without further browser calls; their answer will arrive as a new message.",
              }),
            );
          case "signed_in":
            return textResult(
              JSON.stringify({
                status: "signed_in",
                site: r.site,
                instruction: "Take a snapshot to see where you are.",
              }),
            );
          case "needs_another_step":
            return textResult(
              JSON.stringify({
                status: "needs_another_step",
                site: r.site,
                instruction: NEEDS_STEP,
              }),
            );
          case "failed":
            return errorResult(JSON.stringify({ status: "failed", reason: r.reason }));
        }
      }),
  );
}
