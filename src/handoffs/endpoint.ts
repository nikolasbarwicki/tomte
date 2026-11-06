import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostServerLease } from "../harness/index.ts";
import { serveMcpRequest } from "../host-mcp/index.ts";
import type { TokenRegistry } from "../platform/tokens.ts";
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

export function createBotsEndpoint(deps: BotsEndpointDeps): BotsEndpoint {
  return {
    handle: (req, res) =>
      serveMcpRequest(req, res, {
        port: deps.port(),
        tokens: deps.tokens,
        server: (botId) => createBotsMcpServer({ botId, handoffs: deps.handoffs, cards: deps.cards, botName: deps.botName, deliver: deps.deliver, filesDir: deps.filesDir, show: deps.show }),
      }),

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
