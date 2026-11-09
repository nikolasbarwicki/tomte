import type { IncomingMessage } from "node:http";

import { z } from "zod";

/** A request body that is not a JSON object; the HTTP layers answer it with 400. */
export class InvalidBody extends Error {}

/** A request body over the size limit its route set; the HTTP layers answer it with 413. */
export class BodyTooLarge extends Error {}

const JsonObject = z.record(z.string(), z.unknown());

/**
 * The request's JSON object body; an empty body reads as `{}`. Throws `InvalidBody` for anything else. With `maxBytes`,
 * a longer body throws `BodyTooLarge` once it has been read to its end and dropped, so the caller can still answer on
 * the connection and no more than `maxBytes` of it is ever held.
 */
export async function readJsonObject(
  req: IncomingMessage,
  maxBytes = Infinity,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw new BodyTooLarge(`request body is over ${maxBytes} bytes`);
  const s = Buffer.concat(chunks).toString("utf8");
  if (!s) return {};
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new InvalidBody("request body is not valid JSON");
  }
  const parsed = JsonObject.safeParse(v);
  if (!parsed.success) throw new InvalidBody("request body must be a JSON object");
  return parsed.data;
}
