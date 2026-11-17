import type { Database } from "bun:sqlite";

import { getBot, getOrigin, listBots, setOrigin } from "../bots/index.ts";
import type { CardChat, Channels } from "../channels/index.ts";
import { NO_REFS, type Chats } from "./chats.ts";

/**
 * What the card router needs to give words to a bot (ADR-0010, spec `docs/plans/chief-of-staff/spec.md`, "Phone: `@Name` and replies"): the
 * host's one chat send, with no item, so words from a channel queue on a busy bot, go to a double-loop front as a send and never answer a
 * question or an approval. A send that reached the bot (or its queue) makes the channel the bot's origin, so its replies go back there.
 */
export function createPhoneChat(d: {
  dataRoot: string;
  db: Database;
  chats: Pick<Chats, "send">;
  now: () => number;
}): CardChat {
  return {
    async send(botId, text, channel) {
      const sent = await d.chats.send(botId, text, text, NO_REFS);
      if (sent.outcome !== "refused") setOrigin(d.db, botId, channel, d.now());
      return sent;
    },
    bots: () =>
      listBots(d.dataRoot)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((bot) => ({ id: bot.id, name: bot.name })),
  };
}

/** What happens when a bot says something: while the owner's latest message to it came from a channel, the channel gets it too. */
export function forwardToOrigin(d: {
  dataRoot: string;
  db: Database;
  channels: Pick<Channels, "say">;
}): (botId: string, text: string) => void {
  return (botId, text) => {
    const origin = getOrigin(d.db, botId);
    const bot = getBot(d.dataRoot, botId);
    if (origin === undefined || origin === "web" || !bot) return;
    void d.channels.say(origin, { botId, botName: bot.name, text });
  };
}
