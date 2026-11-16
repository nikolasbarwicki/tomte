import type { Database } from "bun:sqlite";

import type { Inbound, Reply } from "../types.ts";
import { createRouter } from "./router.ts";
import { createCardStore } from "./store.ts";
import { createTracker, type Tracker } from "./tracker.ts";
import type { CardChannels, CardSource } from "./types.ts";

export type { Answered, CardItem, CardSource } from "./types.ts";

export interface CardsDeps {
  db: Database;
  channels: CardChannels;
  /** The kinds of item that get cards; each has its own button prefix. */
  sources: CardSource[];
  /** The URL users reach the host at: every card links to the web UI under it. */
  publicUrl: string;
  now?: () => number;
  /** How long to wait before a failed send is tried again, doubling to a ceiling; 1 second when omitted. */
  retryMs?: number;
}

/**
 * The cards: one message per open needs-you item in every linked channel (ADR-0010), kept in step with the items, and the routing of what the
 * owner does with them. Three separate pieces share a source's shapes: composing (what a card says), tracking (sending it once, editing it
 * once when its item closes) and routing (a button, a reply or plain words reaching the item they answer).
 */
export interface Cards extends Pick<Tracker, "sync" | "stop"> {
  /** Handles an update from the linked account: `Channels.handle(cards.receive)`. */
  receive(kind: string, inbound: Inbound): Promise<Reply>;
}

export function createCards(d: CardsDeps): Cards {
  const store = createCardStore(d.db);
  const now = d.now ?? Date.now;
  const tracker = createTracker({
    store,
    channels: d.channels,
    sources: d.sources,
    publicUrl: d.publicUrl,
    now,
    retryMs: d.retryMs ?? 1000,
  });
  return {
    sync: () => tracker.sync(),
    stop: () => tracker.stop(),
    receive: createRouter({ store, sources: d.sources }),
  };
}
