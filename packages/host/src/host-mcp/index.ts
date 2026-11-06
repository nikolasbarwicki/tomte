import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { HostOrigin } from "../platform/config.ts";
import type { TokenRegistry } from "../platform/tokens.ts";

export interface McpRequestOptions {
  /** Where the host is reachable; the Host header must name it. */
  host: HostOrigin;
  tokens: TokenRegistry;
  /** Why this bot may not use the endpoint right now (answered 403); undefined to let it through. */
  refuse?(botId: string): string | undefined;
  /** A fresh MCP server for the bot the request's token belongs to. */
  server(botId: string): McpServer;
}

function reject(res: ServerResponse, status: number, message: string) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ error: message }));
}

/**
 * Serves one request to a host MCP endpoint (ADR-0001): only a loopback Host naming the host's bound address, no Origin, and a
 * bearer token issued to a live bot session; then one stateless MCP server answers it.
 */
export async function serveMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  o: McpRequestOptions,
): Promise<void> {
  // Blocks DNS rebinding (wrong Host) and web pages (any Origin).
  if (!o.host.namesHost(req.headers.host)) return reject(res, 403, "bad host");
  if (req.headers.origin !== undefined)
    return reject(res, 403, "cross-origin requests are not allowed");
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const botId = bearer ? o.tokens.botOf(bearer) : undefined;
  if (!botId) return reject(res, 401, "missing or invalid token");
  const refused = o.refuse?.(botId);
  if (refused !== undefined) return reject(res, 403, refused);
  if (req.method !== "POST") return reject(res, 405, "method not allowed");

  const mcp = o.server(botId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}
