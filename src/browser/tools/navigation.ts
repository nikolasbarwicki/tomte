import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserToolContext } from "../tools.ts";
import { errorResult, guarded, textResult } from "./result.ts";

interface PageSnapshot {
  origin?: string;
  snapshot?: string;
}

const snapshotText = (page: PageSnapshot) => page.snapshot ?? "(empty page)";

function httpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

export function registerNavigationTools(mcp: McpServer, { browser, egress }: BrowserToolContext) {
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
        const started = Date.now();
        const blocked = () => {
          const hosts = egress.blockedSince(started);
          return hosts.length ? errorResult(`navigation blocked: ${hosts.join(", ")} is a local or internal address, which your browser cannot reach`) : undefined;
        };
        let opened: { title?: string; url?: string };
        try {
          opened = (await browser.call(["open", target.href])) as { title?: string; url?: string };
        } catch (e) {
          // Chrome reports a refused tunnel as a generic network error; the proxy knows why.
          const refused = blocked();
          if (refused) return refused;
          throw e;
        }
        const refused = blocked();
        if (refused) return refused;
        const page = (await browser.call(["snapshot"])) as PageSnapshot;
        return textResult(`Opened ${opened.url ?? target.href}${opened.title ? ` — "${opened.title}"` : ""}\n\n${snapshotText(page)}`);
      }),
  );

  mcp.registerTool(
    "browser_snapshot",
    {
      description: "Read the current page as an accessibility snapshot.",
      inputSchema: {
        interactive_only: z.boolean().optional().describe("Only list elements you can interact with"),
        selector: z.string().min(1).max(500).optional().describe("CSS selector to scope the snapshot to"),
      },
    },
    ({ interactive_only, selector }) =>
      guarded(async () => {
        if (selector?.startsWith("-")) return errorResult("selector must not start with '-'");
        const command = ["snapshot", ...(interactive_only ? ["-i"] : []), ...(selector ? ["-s", selector] : [])];
        const page = (await browser.call(command)) as PageSnapshot;
        return textResult(`${page.origin ? `Page: ${page.origin}\n\n` : ""}${snapshotText(page)}`);
      }),
  );
}
