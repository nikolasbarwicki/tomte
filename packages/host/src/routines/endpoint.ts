import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { HostServerLease } from "../harness/index.ts";
import { serveMcpRequest } from "../host-mcp/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import type { TokenRegistry } from "../platform/tokens.ts";
import type { RoutinesPort, RoutinesToolContext } from "./tools/context.ts";
import { registerCreateRoutine } from "./tools/create-routine.ts";
import { registerListRoutines } from "./tools/list-routines.ts";

export const ROUTINES_ENDPOINT_PATH = "/mcp/routines";
export const ROUTINES_SERVER_NAME = "routines";

/** Delivered as the MCP server's instructions and appended to the bot's system prompt. */
export const ROUTINES_INSTRUCTIONS = [
  "## Routines",
  "You can set up scheduled routines for yourself with the routines tools (mcp__routines__*). Use them when the owner asks for something to happen on a schedule.",
  "- A routine runs later with nobody watching, and it sees only its instruction. Write a self-contained instruction: the goal, where to look, what to produce, and how to end (a summary of at most 5 lines).",
  "- A cron schedule needs the owner's IANA time zone (for example Europe/Warsaw) in `tz`. Read it from user memory. If it is not there, ask the owner with ask_user, then save it with remember (scope user). Never guess it from the server or from the current time.",
  '- A time the owner gives without a zone ("at 8") means that time in their time zone. For a one-time routine, work out the instant from `now` and the zone, and write it with an offset.',
  "- After creating or changing a routine, tell the owner its name, the schedule in plain words with the time zone, and the first of its next_runs.",
  "- To pause a routine, call update_routine with active false. You cannot delete a routine; the owner does that in the Routines panel.",
  "- Routines may not ask the owner questions or create routines. Write instructions that need neither.",
  "- You can see and change only your own routines.",
].join("\n");

export interface RoutinesEndpointDeps extends Pick<RoutinesToolContext, "unattended" | "now"> {
  /** Where the host is reachable; the Host header must name it. */
  host: HostOrigin;
  /** The host-wide token registry shared with the browser and bots endpoints. */
  tokens: TokenRegistry;
  routines: RoutinesPort;
}

export interface RoutinesEndpoint {
  /** Serves a request to `ROUTINES_ENDPOINT_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * A token and URL for one live harness session; every bot gets one. An `attended` lease belongs to a session that is never a
   * scheduled run (a double-loop bot's front), so `unattended` is not asked for its calls: the bot's routine runs go headless in
   * sessions of their own, with leases that are not attended, and must not stop the owner creating routines from the front's chat.
   */
  lease(botId: string, o?: { attended?: boolean }): HostServerLease;
}

/** One MCP server per request, exposing the routines tools for the bot the request's token belongs to. Each tool lives in its own file under `tools/`. */
function createRoutinesMcpServer(ctx: RoutinesToolContext): McpServer {
  const mcp = new McpServer(
    { name: ROUTINES_SERVER_NAME, version: "1.0.0" },
    { instructions: ROUTINES_INSTRUCTIONS },
  );
  registerListRoutines(mcp, ctx);
  registerCreateRoutine(mcp, ctx);
  return mcp;
}

export function createRoutinesEndpoint(deps: RoutinesEndpointDeps): RoutinesEndpoint {
  /** Tokens of attended leases, until released. */
  const attended = new Set<string>();
  return {
    handle: (req, res) =>
      serveMcpRequest(req, res, {
        host: deps.host,
        tokens: deps.tokens,
        server: (botId, token) =>
          createRoutinesMcpServer({
            botId,
            routines: deps.routines,
            unattended: (id) => !attended.has(token) && deps.unattended(id),
            now: deps.now,
          }),
      }),

    lease(botId, o) {
      const { token, revoke } = deps.tokens.issue(botId);
      if (o?.attended) attended.add(token);
      return {
        servers: [
          {
            name: ROUTINES_SERVER_NAME,
            url: `${deps.host.localUrl}${ROUTINES_ENDPOINT_PATH}`,
            token,
          },
        ],
        instructions: ROUTINES_INSTRUCTIONS,
        release: () => {
          attended.delete(token);
          revoke();
        },
      };
    },
  };
}
