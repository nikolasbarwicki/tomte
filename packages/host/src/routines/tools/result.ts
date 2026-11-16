import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const jsonResult = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(v) }],
});
