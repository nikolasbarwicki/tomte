import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
mcp.registerTool("echo_secret", { description: "Return the FIXTURE_SECRET env value", annotations: { readOnlyHint: true } }, async () => ({
  content: [{ type: "text", text: process.env.FIXTURE_SECRET ?? "unset" }],
}));
mcp.registerTool("wipe", { description: "Wipe", annotations: { destructiveHint: true } }, async () => ({ content: [{ type: "text", text: "wiped" }] }));
await mcp.connect(new StdioServerTransport());
