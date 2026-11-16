import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import type { DeviceAuth } from "../device-auth/index.ts";
import { eventsRouteBot } from "../events/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import type { Presence } from "../presence/index.ts";
import type { DeviceSessions } from "./device-sessions.ts";
import { readSessionCookie } from "./session-cookie.ts";

/** The pairing exchange: the one `/api/*` route a device without a token may call with POST. */
export const PAIR_PATH = "/api/pair";

/** What this host is and can do; the one `/api/*` route a device without a token may call with GET. It carries no host state beyond the Claude sign-in. */
export const HOST_INFO_PATH = "/api/host-info";

/** `/oauth/callback` is protected by its OAuth state parameter, not by a device token. */
const OAUTH_CALLBACK_PATH = "/oauth/callback";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A bot's events route: a script posts external events with the bot's event token (ADR-0007), which the route checks
 * itself. It needs no device token and no Origin: callers are scripts, and the bearer header with a JSON body
 * already stops a page on another site.
 */
const isEventsPost = (path: string, method: string) =>
  method === "POST" && eventsRouteBot(path) !== undefined;

/**
 * Everything outside `/api/*` is the static web app or `/oauth/callback`: assets and the login page must load
 * before a device has a token. Anything under `/api/*` needs one, except the pairing exchange, the host-info read
 * and the events post.
 */
const isOpen = (path: string, method: string) =>
  path === PAIR_PATH ||
  (path === HOST_INFO_PATH && method === "GET") ||
  isEventsPost(path, method) ||
  path === OAUTH_CALLBACK_PATH ||
  !path.startsWith("/api/");

/** The device token a request presents: an `Authorization: Bearer` header, else the session cookie. */
function presentedToken(req: IncomingMessage): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  return bearer ?? readSessionCookie(req.headers.cookie);
}

function reject(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
}

/** The event stream every page and the desktop app's banner keep open: it says nothing about the owner being here, so it is never presence. */
const EVENT_STREAM_PATH = "/api/events";

/**
 * The one check every request to the client listener passes before it is routed, so a rejected request never
 * reaches a handler. In order: the Host names this host (403); a mutating request's Origin is the public URL's or
 * the loopback origin (403), which stops other web pages, and its body is JSON (415), which forces a CORS
 * preflight; then a valid device token (401), except on the open paths. The events post is exempt from the Origin
 * rule as well as the device token. The method's own rules stay with its route. A request a device token accepted
 * is the owner's presence, except the event stream.
 */
export function withBoundary(
  origin: HostOrigin,
  devices: DeviceAuth,
  sessions: DeviceSessions,
  presence: Pick<Presence, "touch">,
  next: RequestListener,
): RequestListener {
  return (req, res) => {
    if (!origin.namesHost(req.headers.host)) return reject(res, 403, "bad host");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const method = req.method ?? "";
    if (!SAFE_METHODS.has(method)) {
      if (!isEventsPost(path, method) && !origin.namesOrigin(req.headers.origin))
        return reject(res, 403, "same-origin requests only");
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? ""))
        return reject(res, 415, "content type must be application/json");
    }
    if (!isOpen(path, method)) {
      const token = presentedToken(req);
      const deviceId = token === undefined ? undefined : devices.authenticate(token);
      if (deviceId === undefined) return reject(res, 401, "pair this device first");
      if (!(method === "GET" && path === EVENT_STREAM_PATH)) presence.touch();
      sessions.open(deviceId, req, res);
    }
    next(req, res);
  };
}
