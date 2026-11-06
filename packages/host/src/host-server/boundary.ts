import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import type { DeviceAuth } from "../device-auth/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import type { DeviceSessions } from "./device-sessions.ts";
import { readSessionCookie } from "./session-cookie.ts";

/** The pairing exchange: the one `/api/*` route a device without a token may call. */
export const PAIR_PATH = "/api/pair";

/** `/oauth/callback` is protected by its OAuth state parameter, not by a device token. */
const OAUTH_CALLBACK_PATH = "/oauth/callback";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Everything outside `/api/*` is the static web app or `/oauth/callback`: assets and the login page must load
 * before a device has a token. Anything under `/api/*` needs one, except the pairing exchange.
 */
const isOpen = (path: string) =>
  path === PAIR_PATH || path === OAUTH_CALLBACK_PATH || !path.startsWith("/api/");

/** The device token a request presents: an `Authorization: Bearer` header, else the session cookie. */
function presentedToken(req: IncomingMessage): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  return bearer ?? readSessionCookie(req.headers.cookie);
}

function reject(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
}

/**
 * The one check every request to the client listener passes before it is routed, so a rejected request never
 * reaches a handler. In order: the Host names this host (403); a mutating request's Origin is the public URL's or
 * the loopback origin (403), which stops other web pages, and its body is JSON (415), which forces a CORS
 * preflight; then a valid device token (401), except on the open paths. The method's own rules stay with its route.
 */
export function withBoundary(
  origin: HostOrigin,
  devices: DeviceAuth,
  sessions: DeviceSessions,
  next: RequestListener,
): RequestListener {
  return (req, res) => {
    if (!origin.namesHost(req.headers.host)) return reject(res, 403, "bad host");
    if (!SAFE_METHODS.has(req.method ?? "")) {
      if (!origin.namesOrigin(req.headers.origin))
        return reject(res, 403, "same-origin requests only");
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? ""))
        return reject(res, 415, "content type must be application/json");
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!isOpen(path)) {
      const token = presentedToken(req);
      const deviceId = token === undefined ? undefined : devices.authenticate(token);
      if (deviceId === undefined) return reject(res, 401, "pair this device first");
      sessions.open(deviceId, req, res);
    }
    next(req, res);
  };
}
