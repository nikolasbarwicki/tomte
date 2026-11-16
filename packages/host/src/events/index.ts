import type { Database } from "bun:sqlite";

import type { EventAccess, ExternalEventInput, ExternalEventPosted } from "@claudebot/contract/api";
import type { Relay as RelayStatus, WorkEvent } from "@claudebot/contract/events";

import type { SecretStore } from "../platform/secrets.ts";
import { createRelay, MAX_RELAY_ANSWER, type RelayOptions } from "./relay.ts";
import { createEventStore, type EventItem, type ExternalRow, type OpenItems } from "./store.ts";
import { createEventTokens } from "./token.ts";
import { splitWrapped, wrapExternalEvent } from "./wrap.ts";

export type { EventItem, ExternalRow, OpenItems };

/** The events route's path for a bot: `POST` here with the bot's event token posts an external event to it. */
export const eventsPath = (botId: string) => `/api/bots/${botId}/events`;

/** A request path that is some bot's events route. The boundary lets it through without a device token. */
const EVENTS_ROUTE = /^\/api\/bots\/([^/]+)\/events$/;

/** The bot id in an events route's path, or `undefined` for any other path. */
export const eventsRouteBot = (path: string): string | undefined => EVENTS_ROUTE.exec(path)?.[1];

/** The environment variables a harness process gets so it can post events to its bot. */
const EVENTS_URL_ENV = "CLAUDEBOT_EVENTS_URL";
const EVENTS_TOKEN_ENV = "CLAUDEBOT_EVENTS_TOKEN";

export interface EventsOptions {
  db: Database;
  /** Where event tokens live; the same store the integrations use. */
  secrets: SecretStore;
  /** Whether a bot with this id exists. A token check for a bot that does not fails without reading the secrets. */
  botExists: (botId: string) => boolean;
  /** The events route's full URL for a bot, on the client listener's own origin. */
  routeUrl: (botId: string) => string;
  /** Sends a host message into a bot's session: queued while the bot is busy. A failure is the caller's to report. */
  deliver: (botId: string, text: string) => void;
  /**
   * Called after the bot's work state changed: a new event was stored (before it is delivered), an item was closed or a source was archived.
   * `changed` are the transcript rows of events that left `open` this time, with their new state; none for an archive.
   */
  onChange: (botId: string, changed: ExternalRow[]) => void;
  /**
   * Called when a bot's number of open items changed: an event that is not `progress` was stored, or an item was closed
   * by the user or by `resolves`. Not called for progress, archive or a duplicate.
   */
  onNeedsYou: (botId: string) => void;
  /**
   * Called once for each newly stored event that is not `progress` and not a duplicate, as a needs-you item that is now open: after it is
   * stored and its `resolves` were applied, before it is delivered to the bot. A channel sends it as a card.
   */
  onOpened: (item: EventItem) => void;
  /** The clock for event times, in epoch milliseconds; the system clock when omitted. */
  now?: () => number;
  /** Where the operator's relay configuration is and whether the host runs in remote mode (ADR-0008). */
  relay: RelayOptions;
}

export interface Events {
  /** Whether `token` is the event token of this bot. False for an unknown bot, with no way to tell why. */
  authenticate(botId: string, token: string): Promise<boolean>;
  /**
   * Takes one external event for a bot: a key it has seen is answered as a duplicate and does nothing else; a new
   * event is stored with its source, and unless it is `progress` it reaches the bot, wrapped as untrusted text.
   */
  post(botId: string, event: ExternalEventInput): ExternalEventPosted;
  /**
   * Raises a notice: a needs-you item the host has about itself, from the source "Claudebot". It is stored and shown like any
   * open item (the sidebar count, the Needs-you bar, the banner) but never delivered to the bot, and the user can only dismiss
   * it. `key` dedupes per bot, so posting a key again changes nothing; `title` and `body` are cut to what the events route allows.
   */
  notice(botId: string, notice: { key: string; title: string; body?: string }): ExternalEventPosted;
  /** Closes the bot's open notices whose key starts with `keyPrefix` as `resolved`, because what they report is undone. Dismissed or already closed ones stay as they are. */
  resolveNotices(botId: string, keyPrefix: string): void;
  /**
   * The user answered an open needs-you item with `said`: it becomes `acted` and, when the event names a reply target,
   * the answer is relayed once (ADR-0008). `said` is what the user sent; the `<source> · <title>: ` a draft starts with is
   * not part of the answer. `unchanged` when the item is not open any more, and then nothing is relayed; `unknown` for an id
   * this bot has no needs-you item under.
   */
  answer(botId: string, id: string, said: string): "closed" | "unchanged" | "unknown";
  /** The user drops an open needs-you item. `unchanged` when it is not open any more; `unknown` for an id this bot has no needs-you item under. */
  dismiss(botId: string, id: string): "closed" | "unchanged" | "unknown";
  /**
   * Tries a failed relay again. `started`: it runs now. Otherwise nothing runs and `state` says where it is: still
   * `pending` or already `relayed` (a second request changes nothing), or `failed` never. `none` for an event that has
   * no relay to retry, `unknown` for an id this bot has no needs-you item under.
   */
  retryRelay(
    botId: string,
    id: string,
  ): { started: boolean; state: RelayStatus["state"] } | "none" | "unknown";
  /** Kills relay adapters still running and waits until their outcome is stored. */
  stop(): Promise<void>;
  /** True when the bot has needs-you item `id` in state `open`: not closed, resolved, a `progress` event or another bot's. */
  isOpen(botId: string, id: string): boolean;
  /** An external event that is not `progress` by id, in any state, with everything needed to show it; `undefined` for an unknown id or a `progress` event. */
  item(id: string): EventItem | undefined;
  /** Every open needs-you item of every bot, oldest first. */
  openItems(): EventItem[];
  /** What each bot has open (count, source labels newest first, arrival time of the newest); a bot with none is absent. One query over the open rows only. */
  needsYou(): ReadonlyMap<string, OpenItems>;
  /** A bot's event sources with their work snapshots and recent events: what the page that shows the bot is sent. */
  work(botId: string): WorkEvent;
  /**
   * Archives one of a bot's sources, so it leaves the work event until it posts again. `open`: the source still has an
   * open event, so it stays; `missing`: the bot has no such source.
   */
  archive(botId: string, sourceId: string): "archived" | "open" | "missing";
  /** The route URL and token to show the user, made on first use. */
  access(botId: string): Promise<EventAccess>;
  /**
   * A text delivered to a bot, in order: each external event in it as its transcript row, rebuilt from the stored event,
   * and the text between events as it is. An event this bot has no stored row for leaves no piece, never its raw text.
   */
  split(botId: string, text: string): (string | ExternalRow)[];
  /** Replaces the bot's token; the old one fails at once. */
  rotate(botId: string): Promise<EventAccess>;
  /** What a harness process for this bot needs in its environment. Empty, with the reason logged, when the token cannot be read: the bot still runs. */
  env(botId: string): Promise<Record<string, string>>;
  /** Deletes a bot's token, sources and events. */
  removeBot(botId: string): Promise<void>;
}

/**
 * What the user sent as the answer to an item. A draft the page fills in starts with `<source> · <title>: ` (the
 * needs-you buttons' `draft`); the answer is what follows it. Text that is only the prefix is the answer as it is.
 */
function answerText(row: ExternalRow | undefined, said: string): string {
  if (!row) return said;
  const prefix = `${row.source} · ${row.title}: `;
  if (!said.startsWith(prefix)) return said;
  const rest = said.slice(prefix.length);
  return rest.trim() === "" ? said : rest;
}

/** The events route's limits on a title and a body, which a notice is cut to as well. */
const MAX_NOTICE_TITLE = 200;
const MAX_NOTICE_BODY = 8192;

export function createEvents(o: EventsOptions): Events {
  const store = createEventStore(o.db);
  const tokens = createEventTokens(o.secrets);
  const relay = createRelay(o.relay);
  const now = o.now ?? Date.now;
  const rowsOf = (botId: string, ids: string[]) => ids.flatMap((id) => store.row(botId, id) ?? []);
  /** Relays in flight, so that `stop` can wait for the outcome to be stored. */
  const inflight = new Set<Promise<void>>();

  /** Runs a `pending` relay and stores how it ended, then tells the pages. */
  function runRelay(botId: string, id: string) {
    const job = store.relayJob(botId, id);
    if (!job) return;
    const settled = (async () => {
      const outcome =
        job.answer === null
          ? { error: "the answer was too long to keep, so it cannot be relayed" }
          : await relay.run({ ...job, answer: job.answer });
      if (store.finishRelay(botId, id, outcome)) o.onChange(botId, rowsOf(botId, [id]));
    })()
      .catch((e) => console.error(`[events] relay for ${id} failed: ${(e as Error).message}`))
      .finally(() => inflight.delete(settled));
    inflight.add(settled);
  }

  // A relay still `pending` here was cut off by the host stopping; whether it was delivered is unknown.
  store.failInterrupted(
    "the host stopped while the reply was being sent; it may have been delivered",
  );

  return {
    authenticate: async (botId, token) =>
      o.botExists(botId) && (await tokens.matches(botId, token)),
    post(botId, event) {
      const { resolved, ...posted } = store.record(botId, event, now());
      if (posted.duplicate) return posted;
      o.onChange(botId, rowsOf(botId, resolved));
      if (event.kind !== "progress" || resolved.length > 0) o.onNeedsYou(botId);
      if (event.kind !== "progress") {
        const item = store.item(posted.id);
        if (item) o.onOpened(item);
        o.deliver(botId, wrapExternalEvent(posted.id, event));
      }
      return posted;
    },
    notice(botId, { key, title, body }) {
      const posted = store.recordNotice(
        botId,
        {
          key,
          title: title.slice(0, MAX_NOTICE_TITLE),
          ...(body !== undefined && { body: body.slice(0, MAX_NOTICE_BODY) }),
        },
        now(),
      );
      if (!posted.duplicate) {
        o.onChange(botId, []);
        o.onNeedsYou(botId);
      }
      return posted;
    },
    resolveNotices(botId, keyPrefix) {
      const resolved = store.resolveNotices(botId, keyPrefix);
      if (resolved.length === 0) return;
      o.onChange(botId, []);
      o.onNeedsYou(botId);
    },
    answer(botId, id, said) {
      const text = answerText(store.row(botId, id), said);
      const { outcome, relay: started } = store.answer(
        botId,
        id,
        text.length > MAX_RELAY_ANSWER
          ? {
              failure: `the answer is longer than ${MAX_RELAY_ANSWER} characters, which is too long to relay`,
            }
          : { answer: text },
      );
      if (outcome === "closed") {
        o.onChange(botId, rowsOf(botId, [id]));
        o.onNeedsYou(botId);
        if (started) runRelay(botId, id);
      }
      return outcome;
    },
    dismiss(botId, id) {
      const outcome = store.dismiss(botId, id);
      if (outcome === "closed") {
        o.onChange(botId, rowsOf(botId, [id]));
        o.onNeedsYou(botId);
      }
      return outcome;
    },
    retryRelay(botId, id) {
      const outcome = store.retryRelay(botId, id);
      if (outcome === "none" || outcome === "unknown") return outcome;
      if (outcome !== "started") return { started: false, state: outcome };
      o.onChange(botId, rowsOf(botId, [id]));
      runRelay(botId, id);
      return { started: true, state: "pending" };
    },
    async stop() {
      relay.stop();
      await Promise.all(inflight);
    },
    isOpen: store.isOpen,
    item: (id) => store.item(id),
    openItems: store.openItems,
    needsYou: store.needsYou,
    work: (botId) => ({ type: "work", botId, sources: store.sources(botId) }),
    archive(botId, sourceId) {
      const result = store.archive(botId, sourceId);
      if (result === "archived") o.onChange(botId, []);
      return result;
    },
    access: async (botId) => ({ url: o.routeUrl(botId), token: await tokens.get(botId) }),
    split: (botId, text) =>
      splitWrapped(text).flatMap((piece): (string | ExternalRow)[] => {
        if (typeof piece === "string") return [piece];
        const row = store.row(botId, piece.id);
        return row ? [row] : [];
      }),
    rotate: async (botId) => ({ url: o.routeUrl(botId), token: await tokens.rotate(botId) }),
    async env(botId) {
      try {
        return {
          [EVENTS_URL_ENV]: o.routeUrl(botId),
          [EVENTS_TOKEN_ENV]: await tokens.get(botId),
        };
      } catch (e) {
        console.error(`[events] no event token for ${botId}: ${(e as Error).message}`);
        return {};
      }
    },
    async removeBot(botId) {
      store.removeBot(botId);
      await tokens.remove(botId);
    },
  };
}
