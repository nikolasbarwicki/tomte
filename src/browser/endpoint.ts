import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostServerLease } from "../harness.ts";
import type { BrowserRuntimes } from "./runtime.ts";
import { BROWSER_INSTRUCTIONS, BROWSER_SERVER_NAME, createBrowserMcpServer } from "./tools.ts";
import { TokenRegistry } from "./tokens.ts";

export const BROWSER_ENDPOINT_PATH = "/mcp/browser";

export interface BrowserEndpointDeps {
  /** The port the host listens on; the Host header must name it. */
  port(): number;
  /** The bot's Browser switch, read on every request so turning it off takes effect at once. */
  isEnabled(botId: string): boolean;
  runtimes: BrowserRuntimes;
}

export interface BrowserEndpoint {
  /** Serves a request to `BROWSER_ENDPOINT_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** A token and URL for one live harness session; empty when the bot's switch is off. */
  lease: (botId: string) => HostServerLease;
  revokeBot(botId: string): void;
}

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

export function createBrowserEndpoint(deps: BrowserEndpointDeps): BrowserEndpoint {
  const tokens = new TokenRegistry();

  return {
    async handle(req, res) {
      const port = deps.port();
      // Blocks DNS rebinding (wrong Host) and web pages (any Origin).
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reject(res, 403, "bad host");
      if (req.headers.origin !== undefined) return reject(res, 403, "cross-origin requests are not allowed");
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const botId = bearer ? tokens.botOf(bearer) : undefined;
      if (!botId) return reject(res, 401, "missing or invalid token");
      if (!deps.isEnabled(botId)) return reject(res, 403, "the browser is switched off for this bot");
      if (req.method !== "POST") return reject(res, 405, "method not allowed");

      const mcp = createBrowserMcpServer({ botId, browser: deps.runtimes.forBot(botId) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    },

    lease(botId) {
      if (!deps.isEnabled(botId)) return { servers: [], release() {} };
      const { token, revoke } = tokens.issue(botId);
      return {
        servers: [{ name: BROWSER_SERVER_NAME, url: `http://127.0.0.1:${deps.port()}${BROWSER_ENDPOINT_PATH}`, token }],
        instructions: BROWSER_INSTRUCTIONS,
        release: revoke,
      };
    },

    revokeBot: (botId) => tokens.revokeBot(botId),
  };
}
