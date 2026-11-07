import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import type { UiAsset, UiAssets } from "./assets.ts";

const INDEX = "/index.html";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * What the page may load and do. Scripts and styles only from the host's own origin (no inline code, no `eval`), images may also be
 * `data:` URLs because live view draws each browser frame as `data:image/jpeg;base64,…`, and nothing may frame the page, so injected markup can
 * neither run script nor clickjack the takeover controls.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** The one place a UI response gets its headers. Hashed build output under `/assets/` never changes; everything else, `index.html` first, must be revalidated. `X-Frame-Options` repeats `frame-ancestors` for browsers that predate it. */
function send(req: IncomingMessage, res: ServerResponse, urlPath: string, asset: UiAsset) {
  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": asset.body.byteLength,
    "cache-control": urlPath.startsWith("/assets/") ? IMMUTABLE : "no-cache",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : asset.body);
}

const isApi = (path: string) => path === "/api" || path.startsWith("/api/");
const looksLikeFile = (path: string) => /\.[^/]+$/.test(path);

/**
 * Serves the web UI for what no host route claimed: a file in `assets` by its path, else `index.html` so the
 * router can load a deep link. Only GET and HEAD, never under `/api/`, and a path that looks like a file
 * (`/assets/nope.js`) answers 404 when it is missing rather than the app.
 */
export function serveUi(assets: UiAssets): RequestListener {
  const notFound = (res: ServerResponse) => void res.writeHead(404).end();
  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if ((req.method !== "GET" && req.method !== "HEAD") || isApi(path)) return notFound(res);
    void (async () => {
      const file = path === "/" ? undefined : await assets.read(path);
      if (file) return send(req, res, path, file);
      const index = looksLikeFile(path) ? undefined : await assets.read(INDEX);
      if (index) return send(req, res, INDEX, index);
      notFound(res);
    })().catch((e) => {
      console.error(`[host] serving the web UI failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}
