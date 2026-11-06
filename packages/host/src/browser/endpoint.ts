import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostServerLease } from "../harness/index.ts";
import { serveMcpRequest } from "../host-mcp/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import type { EgressProxy } from "./egress-proxy.ts";
import type { BrowserLogin } from "./login.ts";
import { PageState } from "./page-state.ts";
import type { BrowserRuntimes } from "./runtime.ts";
import { browserIsolation } from "./sandbox.ts";
import type { Takeover } from "./takeover.ts";
import { BROWSER_INSTRUCTIONS, BROWSER_SERVER_NAME, createBrowserMcpServer } from "./tools.ts";

export const BROWSER_ENDPOINT_PATH = "/mcp/browser";

export interface BrowserEndpointDeps {
  /** Where the host is reachable; the Host header must name it. */
  host: HostOrigin;
  /** The bot's Browser switch, read on every request so turning it off takes effect at once. */
  isEnabled(botId: string): boolean;
  runtimes: BrowserRuntimes;
  /** The bot's files folder. */
  filesDir(botId: string): string;
  egress: EgressProxy;
  takeover: Takeover;
  login: BrowserLogin;
  /** True while the bot runs a routine, with no user present. */
  unattended(botId: string): boolean;
  /** The host-wide token registry shared with the other host endpoints; a private one when omitted. */
  tokens?: TokenRegistry;
}

export interface BrowserEndpoint {
  /** Serves a request to `BROWSER_ENDPOINT_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** A token and URL for one live harness session; empty when the bot's switch is off. */
  lease: (botId: string) => HostServerLease;
  revokeBot(botId: string): void;
}

export function createBrowserEndpoint(deps: BrowserEndpointDeps): BrowserEndpoint {
  const tokens = deps.tokens ?? new TokenRegistry();
  const pages = new Map<string, PageState>();

  const pageOf = (botId: string) => {
    let page = pages.get(botId);
    if (!page) pages.set(botId, (page = new PageState()));
    return page;
  };

  return {
    handle: (req, res) =>
      serveMcpRequest(req, res, {
        host: deps.host,
        tokens,
        refuse: (botId) =>
          deps.isEnabled(botId) ? undefined : "the browser is switched off for this bot",
        server: (botId) =>
          createBrowserMcpServer({
            botId,
            browser: deps.runtimes.forBot(botId),
            egress: deps.egress,
            page: pageOf(botId),
            filesDir: deps.filesDir(botId),
            takeover: deps.takeover,
            login: deps.login,
            unattended: () => deps.unattended(botId),
          }),
      }),

    lease(botId) {
      if (!deps.isEnabled(botId)) return { servers: [], release() {} };
      const { token, revoke } = tokens.issue(botId);
      return {
        servers: [
          {
            name: BROWSER_SERVER_NAME,
            url: `${deps.host.localUrl}${BROWSER_ENDPOINT_PATH}`,
            token,
          },
        ],
        instructions: BROWSER_INSTRUCTIONS,
        isolation: browserIsolation(),
        release: revoke,
      };
    },

    revokeBot: (botId) => tokens.revokeBot(botId),
  };
}
