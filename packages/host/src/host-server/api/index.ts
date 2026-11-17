import type { IncomingMessage, ServerResponse } from "node:http";

import { MAX_ATTACHMENT_BYTES } from "@tomte/contract/api";
import { z } from "zod";

import { BodyTooLarge, InvalidBody, readJsonObject } from "../../platform/json-body.ts";
import { json, type Handler } from "../http.ts";
import { botRoutes } from "./bots.ts";
import { channelApi } from "./channels.ts";
import { chatRoutes } from "./chat.ts";
import type { ApiContext, ApiRequest } from "./context.ts";
import { deviceApi } from "./devices.ts";
import { eventSourceRoutes, eventTokenRoutes, needsYouRoutes } from "./external-events.ts";
import { fileRoutes } from "./files.ts";
import { integrationApi } from "./integrations.ts";
import { routineApi } from "./routines.ts";
import { settingsRoutes } from "./settings.ts";

/** The largest `/api/files/attach` body: the attachment in base64, with room for its paths and the JSON around them. */
const MAX_ATTACH_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4 * 2 ** 20;

/** The `/api/*` routes. A malformed body answers 400 with `{ error }`; any other failure answers 500 with the error as the body, without logging. */
export function createApi(ctx: ApiContext): Handler {
  const anyBot = {
    ...botRoutes(ctx),
    ...eventTokenRoutes(ctx),
    ...eventSourceRoutes(ctx),
    ...needsYouRoutes(ctx),
    ...settingsRoutes(ctx),
  };
  const openBot = { ...chatRoutes(ctx), ...fileRoutes(ctx) };

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
  ) {
    if (path === "/api/events") return ctx.events.subscribe(req, res, ctx.snapshot());
    const b = await readJsonObject(
      req,
      path === "/api/files/attach" ? MAX_ATTACH_BODY_BYTES : Infinity,
    );
    if (path.startsWith("/api/devices/")) return deviceApi(ctx, req, res, path, b);
    if (path.startsWith("/api/channels/")) return channelApi(ctx, res, path, b);
    if (path.startsWith("/api/routines/")) return routineApi(ctx, res, path, b);
    if (path.startsWith("/api/integrations/")) return integrationApi(ctx, res, path, b);
    const r: ApiRequest = { res, path, query, parse: (schema) => schema.parse(b) };
    const botRoute = Object.hasOwn(anyBot, path) ? anyBot[path] : undefined;
    if (botRoute) return botRoute(r);
    const chat = ctx.chats.open();
    if (!chat) return json(res, { error: "no bot open; create one first" }, 409);
    const openRoute = Object.hasOwn(openBot, path) ? openBot[path] : undefined;
    if (openRoute) return openRoute(r, chat);
    res.writeHead(404).end();
  }

  return (req, res, url) =>
    api(req, res, url.pathname, url.searchParams).catch((e) => {
      if (!res.headersSent) {
        if (e instanceof InvalidBody) return json(res, { error: e.message }, 400);
        if (e instanceof BodyTooLarge) return json(res, { error: e.message }, 413);
        if (e instanceof z.ZodError) return json(res, { error: z.prettifyError(e) }, 400);
        res.writeHead(500);
      }
      res.end(String(e));
    });
}
