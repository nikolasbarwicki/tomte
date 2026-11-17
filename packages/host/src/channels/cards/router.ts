import type { Inbound, Reply } from "../types.ts";
import { parseButtonData } from "./compose.ts";
import { leadingMention } from "./mention.ts";
import type { CardStore } from "./store.ts";
import type { Answered, CardChat, CardItem, CardSource } from "./types.ts";

const QUEUED = "queued; the bot is busy";
const STALE = "that card is out of date";
const SEVERAL = "Several cards are open. Reply to the card you mean.";

/** What the owner is told, in a toast for a button and in a message for words. */
function told(answered: Answered): string {
  switch (answered.outcome) {
    case "answered":
      return "Answered";
    case "sent":
      return "Sent";
    case "dismissed":
      return "Dismissed";
    case "queued":
      return QUEUED;
    case "refused":
      return answered.reason;
  }
}

/** A message about a button is a toast; one about words is a message, and only when the words did not close the card, which then says so itself. */
const toastOf = (answered: Answered): Reply => ({ toast: told(answered) });
const noteOf = (answered: Answered): Reply =>
  answered.outcome === "queued" || answered.outcome === "refused"
    ? { send: [{ text: told(answered) }] }
    : {};

export interface RouterDeps {
  store: CardStore;
  sources: CardSource[];
  chat: CardChat;
}

/**
 * Routes what the linked account does to what it concerns: a button by its data's prefix to its card, a reply by the message it replies to,
 * and words by this order: a reply to a card goes to that card; `@` and a bot's full name sends the rest to that bot (the chat, not a card);
 * otherwise the one open card takes them, several ask for a reply and with none the owner is told how to reach a bot. Every card answer goes
 * to the item's source, which sends it through the host's answer path. The cards that are open are the ones whose source says the item is.
 */
export function createRouter(d: RouterDeps) {
  const byPrefix = new Map(d.sources.map((s) => [s.prefix, s]));
  const byKind = new Map(d.sources.map((s) => [s.kind, s]));

  /** The cards of one channel whose items are open, oldest first. */
  function openCards(channel: string): { source: CardSource; item: CardItem }[] {
    return d.store.open().flatMap((card) => {
      if (card.channel !== channel) return [];
      const source = byKind.get(card.itemKind);
      const state = source?.view(card.itemId);
      return source && state?.open ? [{ source, item: state.item }] : [];
    });
  }

  async function button(channel: string, data: string): Promise<Reply> {
    const parsed = parseButtonData(data);
    const source = parsed && byPrefix.get(parsed.prefix);
    if (!parsed || !source) return { toast: STALE };
    const card = d.store.find(channel, source.kind, parsed.id);
    const state = source.view(parsed.id);
    if (!card || !state) return { toast: STALE };
    if (!state.open) return { toast: "already handled" };
    if (state.item.botId !== card.botId) return { toast: STALE };
    return toastOf(await source.press(parsed.id, parsed.arg));
  }

  async function words(channel: string, inbound: Inbound & { text: string }): Promise<Reply> {
    const replied = inbound.replyTo ? d.store.byRef(channel, inbound.replyTo) : undefined;
    if (replied) {
      const source = byKind.get(replied.itemKind);
      const state = source?.view(replied.itemId);
      if (!source || !state?.open) return { send: [{ text: "That card is already handled." }] };
      return noteOf(await source.reply(replied.itemId, inbound.text));
    }
    const mention = leadingMention(inbound.text, d.chat.bots());
    if (mention === null) {
      const names = d.chat.bots().map((b) => b.name);
      return {
        send: [
          {
            text: names.length
              ? `No bot has that name. Your bots: ${names.join(", ")}. Start with @ and a bot's full name.`
              : "No bot has that name, and there are no bots yet.",
          },
        ],
      };
    }
    if (mention) {
      if (mention.rest === "")
        return { send: [{ text: `Write your message after @${mention.bot.name}.` }] };
      return noteOf(await d.chat.send(mention.bot.id, mention.rest, channel));
    }
    const open = openCards(channel);
    const [only] = open;
    if (!only) {
      // Newest first, so the example is the bot the owner most likely just made.
      const [newest] = d.chat.bots();
      const text = newest
        ? `To talk to a bot, start with @ and its name, for example @${newest.name}.`
        : "To talk to a bot, start with @ and its name. You have no bots yet.";
      return { send: [{ text }] };
    }
    if (open.length > 1) return { send: [{ text: SEVERAL }] };
    return noteOf(await only.source.reply(only.item.id, inbound.text));
  }

  return async function receive(channel: string, inbound: Inbound): Promise<Reply> {
    if (inbound.button) return button(channel, inbound.button.data);
    if (inbound.text !== undefined) return words(channel, { ...inbound, text: inbound.text });
    return {};
  };
}
