import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EngineError, type PageData } from "../engine-cli.ts";
import type { BrowserToolContext } from "./context.ts";
import { shapePage } from "../shape.ts";
import { guarded, textResult, ToolError } from "./result.ts";

/** What a tool produced: the text for the bot and what the page looked like afterwards, for the loop guard. */
export interface Outcome {
  text: string;
  page: string;
}

const NO_PAGE = "(empty page)";

/** Takes a snapshot of the active tab, numbers its refs, and returns it as untrusted page content. */
export async function snapshotOutcome(ctx: BrowserToolContext, status: string, command: string[] = ["snapshot", "-i"], title?: string): Promise<Outcome> {
  const data = (await ctx.browser.call(command)) as PageData;
  const raw = data.snapshot ?? NO_PAGE;
  const body = `${title ? `Title: ${title}\n` : ""}${ctx.page.numberSnapshot(raw)}`;
  return { text: `${status}\n\n${shapePage({ content: body, origin: data.origin, filesDir: ctx.filesDir })}`, page: raw };
}

/** Wraps arbitrary page text (not a snapshot) as untrusted content. */
export function textOutcome(ctx: BrowserToolContext, status: string, content: string, origin: string | undefined): Outcome {
  return { text: `${status}\n\n${shapePage({ content, origin, filesDir: ctx.filesDir })}`, page: content };
}

/** Runs a tool body under the loop guard: the 6th identical call that leaves the page unchanged is refused. */
export function pageTool(ctx: BrowserToolContext, tool: string, args: object, body: () => Promise<Outcome>): Promise<CallToolResult> {
  const key = `${tool}\n${JSON.stringify(args)}`;
  return guarded(async () => {
    ctx.page.checkLoop(key);
    try {
      const outcome = await body();
      ctx.page.record(key, outcome.page);
      return textResult(outcome.text);
    } catch (e) {
      if (e instanceof EngineError || e instanceof ToolError) ctx.page.record(key, `error: ${e.message}`);
      throw e;
    }
  });
}
