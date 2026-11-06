import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostOrigin } from "../platform/config.ts";

export function rejectRequest(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let s = "";
  for await (const chunk of req) s += chunk;
  try {
    const v = s ? JSON.parse(s) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checks every browser UI route shares: the Host names this server, the Origin is this server's own, the
 * method is POST and the body is JSON (which forces a CORS preflight for other origins). Returns the parsed
 * body, or undefined after answering the rejection itself. Nothing from the body is ever put in an error.
 */
export async function guardUiRequest(req: IncomingMessage, res: ServerResponse, origin: HostOrigin): Promise<Record<string, unknown> | undefined> {
  const host = req.headers.host;
  if (!origin.namesHost(host)) return void rejectRequest(res, 403, "bad host");
  // A page on another origin, or a plain form post, must not be able to watch or drive a bot's browser.
  if (req.headers.origin !== `http://${host}`) return void rejectRequest(res, 403, "same-origin requests only");
  if (req.method !== "POST") return void rejectRequest(res, 405, "method not allowed");
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return void rejectRequest(res, 415, "content type must be application/json");
  const body = await readJson(req);
  if (!body) return void rejectRequest(res, 400, "invalid JSON body");
  return body;
}
