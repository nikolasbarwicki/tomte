import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostServerLease } from "../harness/index.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import type { HandoffStore } from "./store.ts";
import type { BotsToolContext } from "./tools/context.ts";
import { BOTS_INSTRUCTIONS, BOTS_SERVER_NAME, createBotsMcpServer } from "./tools.ts";

export const BOTS_ENDPOINT_PATH = "/mcp/bots";

export interface BotsEndpointDeps extends Pick<BotsToolContext, "cards" | "botName" | "deliver" | "filesDir" | "show"> {
  /** The port the host listens on; the Host header must name it. */
  port(): number;
  /** The host-wide token registry shared with the browser endpoint. */
  tokens: TokenRegistry;
  handoffs: HandoffStore;
}

export interface BotsEndpoint {
  /** Serves a request to `BOTS_ENDPOINT_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** A token and URL for one live harness session; every bot gets one. */
  lease(botId: string): HostServerLease;
}

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

export function createBotsEndpoint(deps: BotsEndpointDeps): BotsEndpoint {
  return {
    async handle(req, res) {
      const port = deps.port();
      // Blocks DNS rebinding (wrong Host) and web pages (any Origin).
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reject(res, 403, "bad host");
      if (req.headers.origin !== undefined) return reject(res, 403, "cross-origin requests are not allowed");
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const botId = bearer ? deps.tokens.botOf(bearer) : undefined;
      if (!botId) return reject(res, 401, "missing or invalid token");
      if (req.method !== "POST") return reject(res, 405, "method not allowed");

      const mcp = createBotsMcpServer({ botId, handoffs: deps.handoffs, cards: deps.cards, botName: deps.botName, deliver: deps.deliver, filesDir: deps.filesDir, show: deps.show });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    },

    lease(botId) {
      const { token, revoke } = deps.tokens.issue(botId);
      return {
        servers: [{ name: BOTS_SERVER_NAME, url: `http://127.0.0.1:${deps.port()}${BOTS_ENDPOINT_PATH}`, token }],
        instructions: BOTS_INSTRUCTIONS,
        release: revoke,
      };
    },
  };
}
