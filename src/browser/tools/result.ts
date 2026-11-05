import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EngineError } from "../engine-cli.ts";
import { BrowserUnavailable } from "../runtime.ts";

export const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
export const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Runs a tool body; engine failures become a tool error the bot can read, anything else is a host bug and propagates. */
export async function guarded(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof EngineError || e instanceof BrowserUnavailable) return errorResult(e.message);
    throw e;
  }
}
