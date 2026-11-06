import type { IncomingMessage } from "node:http";

import { z } from "zod";

/** A request body that is not a JSON object; the HTTP layers answer it with 400. */
export class InvalidBody extends Error {}

const JsonObject = z.record(z.string(), z.unknown());

/** The request's JSON object body; an empty body reads as `{}`. Throws `InvalidBody` for anything else. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) s += chunk;
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
