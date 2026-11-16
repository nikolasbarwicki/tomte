import type { Inbound, Reply } from "../types.ts";
import { parseButtonData } from "./compose.ts";
import type { CardStore } from "./store.ts";
import type { Answered, CardItem, CardSource } from "./types.ts";

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
}

/**
 * Routes what the linked account does to the card it concerns, by the card and never by what an item is: a button by its data's prefix,
 * a reply by the message it replies to, and words alone by the one open card (or none). Every answer goes to the item's source, which sends it
 * through the host's answer path. The cards that are open are the ones whose source says the item is.
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
    const open = openCards(channel);
    // Words with no card to answer change nothing anywhere: no run, session or chat is given them.
    if (open.length === 0) return {};
    const [only] = open;
    if (open.length > 1 || !only) return { send: [{ text: SEVERAL }] };
    return noteOf(await only.source.reply(only.item.id, inbound.text));
  }

  return async function receive(channel: string, inbound: Inbound): Promise<Reply> {
    if (inbound.button) return button(channel, inbound.button.data);
    if (inbound.text !== undefined) return words(channel, { ...inbound, text: inbound.text });
    return {};
  };
}
