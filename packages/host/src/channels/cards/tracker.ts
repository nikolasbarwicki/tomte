import { closedMessage, cardMessage, linkTo } from "./compose.ts";
import type { CardStore } from "./store.ts";
import type { CardChannels, CardItem, CardSource, ItemKind } from "./types.ts";

/** The first and the longest wait before a send that failed is tried again. */
const RETRY_CEILING_FACTOR = 60;

const GONE = "No longer open";

export interface TrackerDeps {
  store: CardStore;
  /** The channels cards are sent through; a channel with no linked account is skipped. */
  channels: CardChannels;
  sources: CardSource[];
  /** The URL users reach the host at, for each card's link. */
  publicUrl: string;
  now: () => number;
  /** How long to wait before trying a failed send again; doubles to a ceiling. */
  retryMs: number;
}

export interface Tracker {
  /**
   * Brings every channel's cards in line with the items: a card whose item left `open` is edited to its outcome, once, and an open item
   * with no card is sent one, oldest first, once. Runs one at a time and at most one is waiting; resolves when the pass that covers the call is done.
   * A send that fails (the channel is down, has no token yet) is tried again later, so an item is not lost while a channel is away.
   */
  sync(): Promise<void>;
  /** Stops retrying and waits for the pass running now. */
  stop(): Promise<void>;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

export function createTracker(d: TrackerDeps): Tracker {
  const sourceOf = new Map<ItemKind, CardSource>(d.sources.map((s) => [s.kind, s]));
  let tail: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = d.retryMs;

  /** Edits the cards of items that closed to their outcome and marks them closed. A failed edit is logged and not tried again: the message may be gone. */
  async function closeSettled() {
    for (const card of d.store.open()) {
      const state = sourceOf.get(card.itemKind)?.view(card.itemId);
      if (state?.open) continue;
      if (!d.store.close(card.channel, card.itemKind, card.itemId, d.now())) continue;
      try {
        await d.channels.edit(
          card.channel,
          card.messageRef,
          state ? closedMessage(state.heading, state.outcome) : { text: GONE },
        );
      } catch (e) {
        console.error(`[channels] editing a ${card.channel} card failed: ${messageOf(e)}`);
      }
    }
  }

  /** Sends a card for every open item that has none, in each linked channel. True when every send that was tried worked. */
  async function sendMissing(): Promise<boolean> {
    const items: { item: CardItem; source: CardSource }[] = d.sources
      .flatMap((source) => source.open().map((item) => ({ item, source })))
      .sort((a, b) => a.item.openedAt - b.item.openedAt);
    let ok = true;
    for (const channel of d.channels.list()) {
      if (channel.link === null) continue;
      for (const { item, source } of items) {
        if (stopped) return ok;
        if (d.store.find(channel.kind, source.kind, item.id)) continue;
        try {
          const sent = await d.channels.send(
            channel.kind,
            cardMessage(item, source.prefix, linkTo(d.publicUrl, item)),
          );
          if (!sent.delivered) break;
          d.store.add({
            channel: channel.kind,
            itemKind: source.kind,
            itemId: item.id,
            botId: item.botId,
            messageRef: sent.ref,
            sentAt: d.now(),
          });
        } catch (e) {
          console.error(`[channels] sending a ${channel.kind} card failed: ${messageOf(e)}`);
          ok = false;
          // Later cards would fail the same way and would overtake this one when it is retried.
          break;
        }
      }
    }
    return ok;
  }

  function retryLater() {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tracker.sync();
    }, delay);
    timer.unref();
    delay = Math.min(delay * 2, d.retryMs * RETRY_CEILING_FACTOR);
  }

  async function pass() {
    if (stopped) return;
    await closeSettled();
    if (await sendMissing()) delay = d.retryMs;
    else retryLater();
  }

  const tracker: Tracker = {
    sync() {
      // A pass already waiting for its turn sees everything the caller changed, so callers share it.
      if (waiting) return waiting;
      const next = tail.then(() => {
        waiting = undefined;
        return pass();
      });
      waiting = next;
      tail = next.catch((e) => console.error(`[channels] syncing cards failed: ${messageOf(e)}`));
      return next;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await tail;
    },
  };
  return tracker;
}
