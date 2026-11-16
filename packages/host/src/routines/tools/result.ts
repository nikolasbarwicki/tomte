import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
export const errorResult = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
export const jsonResult = (v: unknown): CallToolResult => textResult(JSON.stringify(v));
