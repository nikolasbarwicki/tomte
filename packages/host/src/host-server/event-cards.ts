import { itemActions } from "@claudebot/contract/item-actions";

import type { Answered, CardItem, CardSource } from "../channels/index.ts";
import type { EventItem, Events } from "../events/index.ts";
import type { Chats, SendOutcome } from "./chats.ts";

/** What a card is edited to once its external event is no longer open. */
const OUTCOMES: Record<EventItem["state"], string> = {
  open: "Open",
  acted: "Handled",
  dismissed: "Dismissed",
  resolved: "Resolved by its source",
  info: "Handled",
};

const headingOf = (item: EventItem) => `${item.source} · ${item.title}`;

/**
 * An open external event as its card: the buttons are the web UI's (`itemActions` in the contract; one that is only a draft has no button
 * and the card says to reply instead) and Dismiss, which every kind has, so a kind added later with no actions of its own gets Dismiss only.
 */
function cardOf(item: EventItem): CardItem {
  const actions = itemActions(item);
  return {
    id: item.id,
    botId: item.botId,
    openedAt: item.receivedAt,
    heading: headingOf(item),
    ...(item.body !== undefined && { body: item.body }),
    buttons: [
      ...actions.flatMap((a, i) => ("message" in a ? [{ label: a.label, arg: String(i) }] : [])),
      { label: "Dismiss", arg: "d" },
    ],
    reply: actions.some((a) => "draft" in a),
    panel: "work",
  };
}

/** The send outcomes of `Chats.send` as the card sees them. */
function answeredOf(sent: SendOutcome): Answered {
  return sent.outcome === "refused" ? { outcome: "refused", reason: sent.reason } : sent;
}

/**
 * External events as card items (`event`). A button or a reply answers through `Chats.send`, the function the web route uses, with the item's
 * id, so the host, not the channel, decides where the answer goes and closes the item exactly as for an answer from the web UI.
 */
export function createEventCards(d: {
  events: Pick<Events, "item" | "openItems" | "dismiss">;
  chats: Pick<Chats, "send">;
}): CardSource {
  const say = (item: EventItem, text: string, answer?: string) =>
    d.chats.send(item.botId, text, text, [], item.id, answer).then(answeredOf);
  const openItem = (id: string): EventItem | Answered => {
    const item = d.events.item(id);
    if (!item) return { outcome: "refused", reason: "no such item" };
    if (item.state !== "open")
      return { outcome: "refused", reason: "that item is already handled" };
    return item;
  };

  return {
    kind: "event",
    prefix: "a",
    open: () => d.events.openItems().map(cardOf),
    view(id) {
      const item = d.events.item(id);
      if (!item) return undefined;
      return item.state === "open"
        ? { open: true, item: cardOf(item) }
        : { open: false, heading: headingOf(item), outcome: OUTCOMES[item.state] };
    },
    async press(id, arg) {
      const item = openItem(id);
      if ("outcome" in item) return item;
      if (arg === "d") {
        const dismissed = d.events.dismiss(item.botId, id);
        return dismissed === "closed"
          ? { outcome: "dismissed" }
          : { outcome: "refused", reason: "that item is already handled" };
      }
      const action = /^\d+$/.test(arg) ? itemActions(item)[Number(arg)] : undefined;
      if (!action || !("message" in action))
        return { outcome: "refused", reason: "that button is out of date" };
      return say(item, action.message, action.answer);
    },
    async reply(id, text) {
      const item = openItem(id);
      if ("outcome" in item) return item;
      // The web UI's draft starts with the item's heading and a colon; what follows is the answer.
      return say(item, `${headingOf(item)}: ${text}`, text);
    },
  };
}
