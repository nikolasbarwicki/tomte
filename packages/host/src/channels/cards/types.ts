// What a card source tells the channels module about its items. The tracker (sending, closing, editing), the composer (what a card says) and the
// router (what an inbound update means) all work on these shapes and know nothing about what an item is, so a new kind of item (a human wait, a
// notice) is a new `CardSource` and no change here.
import type { ChannelMessage, MessageRef } from "../types.ts";

/** The kinds of item a card is kept for: what `channel_cards.item_kind` holds. */
export type ItemKind = "event" | "wait";

/** A button of a card. `arg` is what the source reads back when it is pressed (an index, a letter); the button's data is `<prefix>:<item id>:<arg>`. */
type CardButton = { label: string; arg: string };

/** An open item as its card shows it. */
export type CardItem = {
  id: string;
  botId: string;
  /** When the item arrived, in epoch milliseconds: cards are sent oldest first. */
  openedAt: number;
  /** The card's first line, such as `<source> · <title>`. */
  heading: string;
  body?: string;
  buttons: CardButton[];
  /** Whether the card tells the owner that a reply to it answers. Set when some action needs words and so has no button. */
  reply: boolean;
  /** The web UI panel the card's link opens, `work` for an external event. */
  panel?: string;
};

/** Where an item stands: open with its card, or closed with the outcome the card is edited to (and the heading it keeps). */
type CardState = { open: true; item: CardItem } | { open: false; heading: string; outcome: string };

/** What came of a button or a reply, in the answer path's terms. `refused` carries a short reason for the owner. */
export type Answered =
  | { outcome: "answered" | "sent" | "dismissed" | "queued" }
  | { outcome: "refused"; reason: string };

/** One kind of item a channel can show as a card. */
export interface CardSource {
  readonly kind: ItemKind;
  /** The first part of every button's data, unique among sources (`a` for an external event). */
  readonly prefix: string;
  /** Every open item of every bot, oldest first. */
  open(): CardItem[];
  /** Where one item stands now; `undefined` when it does not exist (any more). */
  view(id: string): CardState | undefined;
  /** The owner pressed button `arg` of the item's card. */
  press(id: string, arg: string): Promise<Answered>;
  /** The owner answered the item in words. */
  reply(id: string, text: string): Promise<Answered>;
}

/** What the tracker needs of `Channels`: who is linked, and sending and editing through a channel by kind. */
export interface CardChannels {
  list(): { kind: string; link: unknown }[];
  send(
    kind: string,
    message: ChannelMessage,
  ): Promise<{ delivered: true; ref: MessageRef } | { delivered: false }>;
  edit(kind: string, ref: MessageRef, message: ChannelMessage): Promise<void>;
}
