import { toast } from "sonner";
import { z } from "zod";

import { sessionStore } from "./session.ts";
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

/** Posts JSON to the host. A 401 means this browser has no valid device token, so the page falls back to the login. */
export async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) sessionStore.set("unpaired");
  return res;
}

/** Asks the host whether this browser is paired; a 401 flips the page to the login through `post`. */
export async function probeSession(): Promise<void> {
  if ((await post("/api/info", {})).ok) sessionStore.set("paired");
}

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

/** What the host did with a message: `answered` a question the bot was waiting on, `sent` it to the bot, or `queued` it until the bot is free. */
export type SendOutcome = "answered" | "sent" | "queued";

/**
 * Sends a chat message to the open bot, as the composer does; `mentions` are the ids of bots it hands off to. `eventId` is the
 * needs-you item the message answers: the host resolves the bot's pending question about it (with `answer`, or the text), or
 * sends the message, and closes the item once the bot has it, never while the message only waits in the queue.
 * Resolves to what happened, or `undefined` when the host refused it (shown as a toast).
 */
export async function sendMessage(
  text: string,
  mentions: string[],
  eventId?: string,
  answer?: string,
): Promise<SendOutcome | undefined> {
  const res = await post("/api/send", {
    text,
    mentions,
    ...(eventId !== undefined && { eventId }),
    ...(answer !== undefined && { answer }),
  });
  if (!res.ok) {
    toast.error(await errorOf(res));
    return undefined;
  }
  return ((await res.json()) as { outcome: SendOutcome }).outcome;
}

/** Asks the host to stream `botId`'s chat; a no-op when it already is. */
export function openBot(botId: string): void {
  if (botId !== hostStore.get().openBotId) void act("/api/open", { botId });
}

/** Tells the host the user has looked at `botId`'s finished turn. */
export const markSeen = (botId: string) => post("/api/seen", { botId });

/** Deletes `botId` on the host; resolves to whether it did (a working bot is refused). */
export const deleteBot = (botId: string) => act("/api/bots/delete", { botId });
