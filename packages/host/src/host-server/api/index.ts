import type { IncomingMessage, ServerResponse } from "node:http";

import { body, json, type Handler } from "../http.ts";
import { botRoutes } from "./bots.ts";
import { chatRoutes } from "./chat.ts";
import type { ApiContext, ApiRequest } from "./context.ts";
import { credentialApi } from "./credentials.ts";
import { fileRoutes } from "./files.ts";
import { integrationApi } from "./integrations.ts";
import { routineApi } from "./routines.ts";

/** The `/api/*` routes. A failure answers 500 with the error as the body, without logging. */
export function createApi(ctx: ApiContext): Handler {
  const anyBot = botRoutes(ctx);
  const openBot = { ...chatRoutes(ctx), ...fileRoutes(ctx) };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === "/api/events") return ctx.events.subscribe(req, res, ctx.snapshot());
    const b = await body(req);
    if (path.startsWith("/api/routines/")) return routineApi(ctx, res, path, b);
    if (path.startsWith("/api/integrations/")) return integrationApi(ctx, res, path, b);
    if (path.startsWith("/api/credentials/")) {
      const r = await credentialApi(ctx.credentials, path, b);
      return r ? json(res, r.body, r.status) : void res.writeHead(404).end();
    }
    const r: ApiRequest = {
      res,
      path,
      body: b,
      str: (key) => (typeof b[key] === "string" ? (b[key] as string) : ""),
    };
    if (Object.hasOwn(anyBot, path)) return anyBot[path](r);
    const chat = ctx.chats.open();
    if (!chat) return json(res, { error: "no bot open; create one first" }, 409);
    if (Object.hasOwn(openBot, path)) return openBot[path](r, chat);
    res.writeHead(404).end();
  }

  return (req, res, url) =>
    api(req, res, url.pathname).catch((e) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    });
}
