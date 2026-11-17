import {
  ArchiveSourceRequest,
  EventItemRequest,
  EventTokenRequest,
  ExternalEventInput,
  MAX_EVENT_BODY_BYTES,
  type EventAccess,
} from "@tomte/contract/api";

import { getBot } from "../../bots/index.ts";
import { eventsRouteBot, type Events } from "../../events/index.ts";
import { BodyTooLarge, InvalidBody, readJsonObject } from "../../platform/json-body.ts";
import { json, type Handler } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

/**
 * `POST /api/bots/<botId>/events`: an external process posts one event to a bot, authenticated by that bot's event
 * token alone (ADR-0007). A missing token, a wrong one, another bot's and an unknown bot all get the same 401, before
 * the body is read. Then: 413 for a body over 64 KiB, 400 for anything that is not a valid event, naming the first
 * problem's path, 202 for a new event and 200 when its key was already seen.
 */
export function externalEventsRoute(events: Events): Handler {
  return async (req, res, url) => {
    const botId = eventsRouteBot(url.pathname);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (botId === undefined || token === undefined || !(await events.authenticate(botId, token)))
      return json(res, { error: "invalid event token" }, 401);
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, MAX_EVENT_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return json(res, { error: e.message }, 413);
      if (e instanceof InvalidBody) return json(res, { error: e.message }, 400);
      throw e;
    }
    const parsed = ExternalEventInput.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return json(res, { error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, 400);
    }
    const posted = events.post(botId, parsed.data);
    return json(res, posted, posted.duplicate ? 200 : 202);
  };
}

/** The UI's side of the event token, for a device: read the bot's route URL and token to copy, or rotate the token. */
export function eventTokenRoutes({ dataRoot, externalEvents }: ApiContext): ApiRoutes {
  const route =
    (act: (botId: string) => Promise<EventAccess>): ApiRoutes[string] =>
    async ({ res, parse }) => {
      const bot = getBot(dataRoot, parse(EventTokenRequest).botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      return json(res, await act(bot.id));
    };
  return {
    "/api/bots/events-token": route((botId) => externalEvents.access(botId)),
    "/api/bots/events-token/rotate": route((botId) => externalEvents.rotate(botId)),
  };
}

/** The UI's side of an event source's lifecycle, for a device: archive a source that has nothing open. */
export function eventSourceRoutes({ dataRoot, externalEvents }: ApiContext): ApiRoutes {
  return {
    "/api/bots/events/archive": async ({ res, parse }) => {
      const { botId, sourceId } = parse(ArchiveSourceRequest);
      const bot = getBot(dataRoot, botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      const result = externalEvents.archive(bot.id, sourceId);
      if (result === "missing") return json(res, { error: "no such source" }, 404);
      if (result === "open")
        return json(
          res,
          { error: "the source still has open items; act on or dismiss them first" },
          409,
        );
      return json(res, { ok: true });
    },
  };
}

/**
 * The UI's side of the needs-you queue, for a device: `dismiss` drops an item and `relay/retry` tries the relay of an answer
 * again (ADR-0008). Answering an item goes through `/api/send`, which closes it as acted. `dismiss` answers `{ closed }`:
 * false when the item was not open any more, so a second device that races the first changes nothing. `relay/retry` answers
 * `{ started, state }`: a retry that is already running or already done changes nothing; 409 for an item with no relay to
 * retry. A bot or event this host does not know is 404.
 */
export function needsYouRoutes({ dataRoot, externalEvents }: ApiContext): ApiRoutes {
  return {
    "/api/bots/events/dismiss": async ({ res, parse }) => {
      const { botId, id } = parse(EventItemRequest);
      if (!getBot(dataRoot, botId)) return json(res, { error: "no such bot" }, 404);
      const outcome = externalEvents.dismiss(botId, id);
      if (outcome === "unknown") return json(res, { error: "no such event" }, 404);
      return json(res, { closed: outcome === "closed" });
    },
    "/api/bots/events/relay/retry": async ({ res, parse }) => {
      const { botId, id } = parse(EventItemRequest);
      if (!getBot(dataRoot, botId)) return json(res, { error: "no such bot" }, 404);
      const outcome = externalEvents.retryRelay(botId, id);
      if (outcome === "unknown") return json(res, { error: "no such event" }, 404);
      if (outcome === "none") return json(res, { error: "that item has no reply to retry" }, 409);
      return json(res, outcome);
    },
  };
}
