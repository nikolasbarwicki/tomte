import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostServerLease } from "../harness/index.ts";
import { serveMcpRequest } from "../host-mcp/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import type { TokenRegistry } from "../platform/tokens.ts";
import type { HandoffStore } from "./store.ts";
import { BOTS_INSTRUCTIONS, BOTS_SERVER_NAME, createBotsMcpServer } from "./tools.ts";
import type { BotsToolContext } from "./tools/context.ts";

export const BOTS_ENDPOINT_PATH = "/mcp/bots";

export interface BotsEndpointDeps extends Pick<
  BotsToolContext,
  "cards" | "botName" | "deliver" | "filesDir" | "show" | "createBot"
> {
  /** Where the host is reachable; the Host header must name it. */
  host: HostOrigin;
  /** The host-wide token registry shared with the browser endpoint. */
  tokens: TokenRegistry;
  handoffs: HandoffStore;
  /** Whether the bot is in a scheduled run right now. */
  unattended(botId: string): boolean;
}

export interface BotsEndpoint {
  /** Serves a request to `BOTS_ENDPOINT_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * A token and URL for one live harness session; every bot gets one. An `attended` lease belongs to a session that is never a
   * scheduled run (a double-loop bot's front), so `unattended` is not asked for its calls: the bot's routine runs go headless in
   * sessions of their own, with leases that are not attended.
   */
  lease(botId: string, o?: { attended?: boolean }): HostServerLease;
}

export function createBotsEndpoint(deps: BotsEndpointDeps): BotsEndpoint {
  /** Tokens of attended leases, until released. */
  const attended = new Set<string>();
  return {
    handle: (req, res) =>
      serveMcpRequest(req, res, {
        host: deps.host,
        tokens: deps.tokens,
        server: (botId, token) =>
          createBotsMcpServer({
            botId,
            handoffs: deps.handoffs,
            cards: deps.cards,
            botName: deps.botName,
            deliver: deps.deliver,
            filesDir: deps.filesDir,
            show: deps.show,
            createBot: deps.createBot,
            unattended: () => !attended.has(token) && deps.unattended(botId),
          }),
      }),

    lease(botId, o) {
      const { token, revoke } = deps.tokens.issue(botId);
      if (o?.attended) attended.add(token);
      return {
        servers: [
          { name: BOTS_SERVER_NAME, url: `${deps.host.localUrl}${BOTS_ENDPOINT_PATH}`, token },
        ],
        instructions: BOTS_INSTRUCTIONS,
        release: () => {
          attended.delete(token);
          revoke();
        },
      };
    },
  };
}
