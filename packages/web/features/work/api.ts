import { EventAccess } from "@claudebot/contract/api";

import { act, errorOf, post, readJson } from "@/host/api.ts";

async function access(path: string, botId: string): Promise<EventAccess> {
  const res = await post(path, { botId });
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, EventAccess);
}

/** The bot's events URL and token, made on first use; throws the host's error message when the request fails. */
export const eventAccess = (botId: string) => access("/api/bots/events-token", botId);

/** Replaces the bot's event token; the old one stops working at once. */
export const rotateEventToken = (botId: string) => access("/api/bots/events-token/rotate", botId);

/** Archives one of the bot's sources so it leaves the list; the host refuses while the source has open items. Resolves to whether it did. */
export const archiveSource = (botId: string, sourceId: string) =>
  act("/api/bots/events/archive", { botId, sourceId });
