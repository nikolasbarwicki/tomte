import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BROWSER_FILES_DIR } from "../../bots/index.ts";
import { shapePage } from "../shape.ts";
import type { BrowserToolContext } from "./context.ts";
import { httpUrl } from "./navigation.ts";
import { pageTool, snapshotOutcome, textOutcome } from "./page.ts";
import { ToolError } from "./result.ts";

const ref = z.string().max(40).describe("A ref from the latest snapshot, like r3.e5");
const tabId = z
  .string()
  .regex(/^t\d{1,4}$/)
  .describe("A tab id from the tab list, like t2");
const KEY = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/;

/** The engine reads a lone `--flag` or `-x` argument as its own option, so text that could be one is refused. */
function plainText(text: string): string {
  if (text.length > 5_000) throw new ToolError("text is too long (limit 5000 characters)");
  if (/^-[-A-Za-z]/.test(text))
    throw new ToolError(
      "text must not start with '-' followed by a letter or '-'; rephrase it or put a space first",
    );
  return text;
}

export function registerActionTools(mcp: McpServer, ctx: BrowserToolContext) {
  const { browser, page } = ctx;
  /** Runs an action, then returns its status line with a fresh interactive snapshot. */
  const act = (tool: string, args: object, command: () => string[], status: string) =>
    pageTool(ctx, tool, args, async () => {
      await browser.call(command());
      return snapshotOutcome(ctx, status);
    });

  mcp.registerTool(
    "browser_click",
    { description: "Click an element by ref. Returns a fresh snapshot.", inputSchema: { ref } },
    (a) => act("browser_click", a, () => ["click", page.engineRef(a.ref)], `Clicked ${a.ref}.`),
  );

  mcp.registerTool(
    "browser_fill",
    {
      description: "Clear an input and fill it with text. Returns a fresh snapshot.",
      inputSchema: { ref, text: z.string() },
    },
    (a) =>
      act(
        "browser_fill",
        a,
        () => ["fill", page.engineRef(a.ref), plainText(a.text)],
        `Filled ${a.ref}.`,
      ),
  );

  mcp.registerTool(
    "browser_type",
    {
      description:
        "Type text into an element key by key, keeping what is already there. Returns a fresh snapshot.",
      inputSchema: { ref, text: z.string() },
    },
    (a) =>
      act(
        "browser_type",
        a,
        () => ["type", page.engineRef(a.ref), plainText(a.text)],
        `Typed into ${a.ref}.`,
      ),
  );

  mcp.registerTool(
    "browser_press",
    {
      description:
        "Press a key or chord such as Enter, Tab or Control+a. Returns a fresh snapshot.",
      inputSchema: { key: z.string().max(40) },
    },
    (a) =>
      act(
        "browser_press",
        a,
        () => {
          if (!KEY.test(a.key)) throw new ToolError("key must look like Enter, Tab or Control+a");
          return ["press", a.key];
        },
        `Pressed ${a.key}.`,
      ),
  );

  mcp.registerTool(
    "browser_select",
    {
      description:
        "Choose an option of a dropdown by value or visible label. Returns a fresh snapshot.",
      inputSchema: { ref, value: z.string().max(500) },
    },
    (a) =>
      act(
        "browser_select",
        a,
        () => ["select", page.engineRef(a.ref), plainText(a.value)],
        `Selected "${a.value.replace(/\s+/g, " ").slice(0, 80)}" in ${a.ref}.`,
      ),
  );

  mcp.registerTool(
    "browser_scroll",
    {
      description:
        "Scroll the page in a direction, or scroll an element into view by ref. Give exactly one of direction or ref. Returns a fresh snapshot.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        ref: ref.optional(),
      },
    },
    (a) =>
      act(
        "browser_scroll",
        a,
        () => {
          if ((a.direction === undefined) === (a.ref === undefined))
            throw new ToolError("give exactly one of direction or ref");
          return a.ref ? ["scrollintoview", page.engineRef(a.ref)] : ["scroll", a.direction!];
        },
        a.ref ? `Scrolled ${a.ref} into view.` : `Scrolled ${a.direction}.`,
      ),
  );

  mcp.registerTool(
    "browser_back",
    {
      description: "Go back one page in the active tab. Returns a fresh snapshot.",
      inputSchema: {},
    },
    () => act("browser_back", {}, () => ["back"], "Went back."),
  );

  mcp.registerTool(
    "browser_get_text",
    {
      description: "Read the visible text of the page, or of one element by ref.",
      inputSchema: { ref: ref.optional() },
    },
    (a) =>
      pageTool(ctx, "browser_get_text", a, async () => {
        const target = a.ref ? page.engineRef(a.ref) : "body";
        const data = (await browser.call(["get", "text", target])) as {
          origin?: string;
          text?: string;
        };
        return textOutcome(
          ctx,
          a.ref ? `Text of ${a.ref}.` : "Text of the page.",
          data.text ?? "",
          data.origin,
        );
      }),
  );

  mcp.registerTool(
    "browser_screenshot",
    {
      description:
        "Take a screenshot of the active tab. It is saved as an image file in your files folder; the path is returned.",
      inputSchema: {},
    },
    () =>
      pageTool(ctx, "browser_screenshot", {}, async () => {
        const dir = join(ctx.filesDir, BROWSER_FILES_DIR);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `screenshot-${Date.now()}.png`);
        await browser.call(["screenshot", file]);
        return { text: `Screenshot saved to ${file}`, page: "screenshot" };
      }),
  );

  mcp.registerTool(
    "browser_tabs",
    {
      description:
        "List, switch, open or close tabs. Switching, opening and closing return a fresh snapshot of the active tab.",
      inputSchema: {
        action: z.enum(["list", "switch", "new", "close"]),
        tab: tabId
          .optional()
          .describe("Tab id for switch; optional for close (default: the active tab)"),
        url: z.string().optional().describe("Absolute http or https URL to open in a new tab"),
      },
    },
    (a) =>
      pageTool(ctx, "browser_tabs", a, async () => {
        if (a.action === "list") {
          const data = (await browser.call(["tab", "list"])) as {
            tabs?: { tabId: string; title?: string; url?: string; active?: boolean }[];
          };
          const lines = (data.tabs ?? []).map((t) =>
            `${t.active ? "* " : "  "}${t.tabId} ${t.url ?? ""} ${t.title ? `"${t.title}"` : ""}`.trimEnd(),
          );
          return {
            text: `Tabs (* is active):\n\n${shapePage({ content: lines.join("\n") || "(no tabs)", origin: "tab list", filesDir: ctx.filesDir })}`,
            page: lines.join("\n"),
          };
        }
        if (a.action === "switch") {
          if (!a.tab) throw new ToolError("switch needs a tab id");
          await browser.call(["tab", a.tab]);
          return snapshotOutcome(ctx, `Switched to ${a.tab}.`);
        }
        if (a.action === "new") {
          const target = a.url === undefined ? undefined : httpUrl(a.url);
          if (a.url !== undefined && !target)
            throw new ToolError("only absolute http and https URLs can be opened");
          await browser.call(["tab", "new", ...(target ? [target.href] : [])]);
          return snapshotOutcome(ctx, "Opened a new tab.");
        }
        await browser.call(["tab", "close", ...(a.tab ? [a.tab] : [])]);
        return snapshotOutcome(ctx, a.tab ? `Closed ${a.tab}.` : "Closed the active tab.");
      }),
  );
}
