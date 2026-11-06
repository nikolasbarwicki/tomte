import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserToolContext } from "./context.ts";
import { pageTool, snapshotOutcome } from "./page.ts";
import { errorResult, guarded, ToolError } from "./result.ts";

export function httpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

export function registerNavigationTools(mcp: McpServer, ctx: BrowserToolContext) {
  const { browser, egress } = ctx;
  mcp.registerTool(
    "browser_open",
    {
      description: "Open a web page in your browser and return an accessibility snapshot of it.",
      inputSchema: { url: z.string().describe("Absolute http or https URL") },
    },
    ({ url }) =>
      guarded(async () => {
        const target = httpUrl(url);
        if (!target) return errorResult("only absolute http and https URLs can be opened");
        return pageTool(ctx, "browser_open", { url }, async () => {
          const started = Date.now();
          const blocked = () => {
            const hosts = egress.blockedSince(started);
            return hosts.length ? new ToolError(`navigation blocked: ${hosts.join(", ")} is a local or internal address, which your browser cannot reach`) : undefined;
          };
          let opened: { title?: string };
          try {
            opened = (await browser.call(["open", target.href])) as { title?: string };
          } catch (e) {
            // Chrome reports a refused tunnel as a generic network error; the proxy knows why.
            throw blocked() ?? e;
          }
          const refused = blocked();
          if (refused) throw refused;
          return snapshotOutcome(ctx, `Opened ${target.href}`, ["snapshot"], opened.title);
        });
      }),
  );

  mcp.registerTool(
    "browser_snapshot",
    {
      description: "Read the current page as an accessibility snapshot. Refs in it (like r3.e5) are valid until the next snapshot.",
      inputSchema: {
        interactive_only: z.boolean().optional().describe("Only list elements you can interact with"),
        selector: z.string().min(1).max(500).optional().describe("CSS selector to scope the snapshot to"),
      },
    },
    ({ interactive_only, selector }) =>
      guarded(async () => {
        if (selector?.startsWith("-")) return errorResult("selector must not start with '-'");
        const command = ["snapshot", ...(interactive_only ? ["-i"] : []), ...(selector ? ["-s", selector] : [])];
        return pageTool(ctx, "browser_snapshot", { interactive_only, selector }, () => snapshotOutcome(ctx, "Snapshot of the current page.", command));
      }),
  );
}
