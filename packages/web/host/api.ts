import { toast } from "sonner";
import { z } from "zod";

import { hostStore } from "./store.ts";

/** A payload from the host that does not match its contract schema; `message` names where it came from. */
export class InvalidPayload extends Error {}

/** Parses JSON text from `source` with `schema`, throwing `InvalidPayload` on bad JSON or a mismatch. */
export function parseJson<T>(text: string, schema: z.ZodType<T>, source: string): T {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new InvalidPayload(`${source}: not valid JSON`);
  }
  const parsed = schema.safeParse(v);
  if (!parsed.success)
    throw new InvalidPayload(`${source}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  return parsed.data;
}

/** A response body parsed with `schema`; see `parseJson`. */
export async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return parseJson(await res.text(), schema, res.url || "response");
}

export const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ErrorBody = z.object({ error: z.string() });

/** The `error` the host put in a failed response, or a generic line when it sent none. */
export async function errorOf(res: Response): Promise<string> {
  const body = ErrorBody.safeParse(await res.json().catch(() => undefined));
  return body.success ? body.data.error : `Request failed (${res.status})`;
}

/** Posts an action and shows its failure as a toast; resolves to whether it succeeded. */
export async function act(path: string, body: unknown): Promise<boolean> {
  const res = await post(path, body);
  if (res.ok) return true;
  toast.error(await errorOf(res));
  return false;
}

/** Asks the host to stream `botId`'s chat; a no-op when it already is. */
export function openBot(botId: string): void {
  if (botId !== hostStore.get().openBotId) void act("/api/open", { botId });
}

/** Tells the host the user has looked at `botId`'s finished turn. */
export const markSeen = (botId: string) => post("/api/seen", { botId });
