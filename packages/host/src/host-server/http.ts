import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import {
  BROWSER_ENDPOINT_PATH,
  BROWSER_UI_PATHS,
  CREDENTIAL_EXCHANGE_PATH,
  LIVE_VIEW_PATH,
  type Browser,
} from "../browser/index.ts";
import { BOTS_ENDPOINT_PATH, type Handoffs } from "../handoffs/index.ts";
import { HOST_INFO_PATH, PAIR_PATH } from "./boundary.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export interface Route {
  match: (path: string, req: IncomingMessage) => boolean;
  handler: Handler;
  /** Log prefix for a failure; the handler then answers 500. A route without a label handles its own errors. */
  label?: string;
}

/** Logs a failed handler under `label` and ends the response, with 500 when nothing was sent yet. */
function safe(handler: Handler, label: string): Handler {
  return (req, res, url) =>
    handler(req, res, url).catch((e) => {
      console.error(`${label} ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
}

/** What the agent listener serves: the browser endpoint, the bots endpoint and the credential exchange. */
export function agentRoutes(o: { browser: Browser; handoffs: Handoffs }): Route[] {
  const { browser, handoffs } = o;
  return [
    {
      match: (p) => p === BROWSER_ENDPOINT_PATH,
      handler: (req, res) => browser.endpoint.handle(req, res),
      label: "[browser] endpoint failed:",
    },
    {
      match: (p) => p === BOTS_ENDPOINT_PATH,
      handler: (req, res) => handoffs.endpoint.handle(req, res),
      label: "[bots] endpoint failed:",
    },
    {
      match: (p) => p === CREDENTIAL_EXCHANGE_PATH,
      handler: (req, res) => browser.handleCredentialExchange(req, res),
      label: "[browser] credential exchange failed:",
    },
  ];
}

/** What the client listener serves besides the web app, in match order. `oauthCallback`, `hostInfo` and `api` answer their own failures. */
export function clientRoutes(o: {
  browser: Browser;
  oauthCallback: Handler;
  pair: Handler;
  hostInfo: Handler;
  api: Handler;
}): Route[] {
  const { browser } = o;
  return [
    {
      match: (p, req) => p === "/oauth/callback" && req.method === "GET",
      handler: o.oauthCallback,
    },
    {
      match: (p, req) => p === PAIR_PATH && req.method === "POST",
      handler: o.pair,
      label: "[host] pairing failed:",
    },
    { match: (p, req) => p === HOST_INFO_PATH && req.method === "GET", handler: o.hostInfo },
    {
      match: (p) => p === LIVE_VIEW_PATH,
      handler: (req, res) => browser.handleLiveView(req, res),
      label: "[browser] live view failed:",
    },
    {
      match: (p) => BROWSER_UI_PATHS.has(p),
      handler: (req, res, url) => browser.handleUi(req, res, url.pathname),
      label: "[browser] ui route failed:",
    },
    {
      // Under /api/, so the generic API would answer it; the exchange belongs to the agent listener alone.
      match: (p) => p === CREDENTIAL_EXCHANGE_PATH,
      handler: async (_req, res) => void res.writeHead(404).end(),
    },
    { match: (p) => p.startsWith("/api/"), handler: o.api },
  ];
}

/** Serves the first matching route, `fallback` when none matches. */
export function createRequestListener(routes: Route[], fallback: RequestListener): RequestListener {
  const table = routes.map((r) => ({
    match: r.match,
    handler: r.label ? safe(r.handler, r.label) : r.handler,
  }));
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = table.find((r) => r.match(url.pathname, req));
    if (route) return void route.handler(req, res, url);
    fallback(req, res);
  };
}

export function json(res: ServerResponse, v: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
}
