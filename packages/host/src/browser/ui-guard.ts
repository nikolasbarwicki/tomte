import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { HostOrigin } from "../platform/config.ts";

export function rejectRequest(res: ServerResponse, status: number, message: string) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ error: message }));
}

const JsonObject = z.record(z.string(), z.unknown());

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let s = "";
  for await (const chunk of req) s += chunk;
  if (!s) return {};
  try {
    const parsed = JsonObject.safeParse(JSON.parse(s));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checks every browser UI route shares: the Host names this server, the Origin is this server's own, the
 * method is POST and the body is JSON (which forces a CORS preflight for other origins). Returns the parsed
 * body, or undefined after answering the rejection itself. Nothing from the body is ever put in an error.
 */
export async function guardUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  origin: HostOrigin,
): Promise<Record<string, unknown> | undefined> {
  const host = req.headers.host;
  const reject = (status: number, message: string) => {
    rejectRequest(res, status, message);
    return undefined;
  };
  if (!origin.namesHost(host)) return reject(403, "bad host");
  // A page on another origin, or a plain form post, must not be able to watch or drive a bot's browser.
  if (req.headers.origin !== `http://${host}`) return reject(403, "same-origin requests only");
  if (req.method !== "POST") return reject(405, "method not allowed");
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? ""))
    return reject(415, "content type must be application/json");
  const body = await readJson(req);
  if (!body) return reject(400, "invalid JSON body");
  return body;
}
