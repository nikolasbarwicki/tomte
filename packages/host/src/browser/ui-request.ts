import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { InvalidBody, readJsonObject } from "../platform/json-body.ts";

export function rejectRequest(res: ServerResponse, status: number, message: string) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ error: message }));
}

/** The body every per-bot browser UI route starts from. */
export const BotRef = z.object({ botId: z.string().min(1) });

/**
 * The body of a browser UI request, which the client listener's boundary check has already vetted for Host,
 * Origin, content type and device token. The routes act, so only POST is allowed. Returns the parsed body, or
 * undefined after answering the rejection itself. Nothing from the body is ever put in an error.
 */
export async function readUiBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const reject = (status: number, message: string) => {
    rejectRequest(res, status, message);
    return undefined;
  };
  if (req.method !== "POST") return reject(405, "method not allowed");
  try {
    return await readJsonObject(req);
  } catch (e) {
    if (e instanceof InvalidBody) return reject(400, "invalid JSON body");
    throw e;
  }
}
