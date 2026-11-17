import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import type { ChannelStatus } from "@tomte/contract/api";

import { NotFound } from "../platform/errors.ts";
import { noticeMessage, type Notice } from "./notices.ts";
import { replyMessage, type BotReply } from "./replies.ts";
import { createChannelStore } from "./store.ts";
import type {
  Account,
  Channel,
  ChannelMessage,
  Inbound,
  MessageRef,
  Reply,
  TokenOutcome,
} from "./types.ts";

export { createCards } from "./cards/index.ts";
export type { Answered, CardChat, CardItem, CardSource } from "./cards/index.ts";
export { createTelegramChannel, type TelegramOptions } from "./telegram/channel.ts";
export { Notice } from "./notices.ts";
export type { Account, Channel, ChannelMessage, Inbound, MessageRef, Reply } from "./types.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 12;
const GROUP = 4;
/** Longer text is never a code, so it is not normalized at all. */
const MAX_CODE_TEXT = 64;

/** What handles an update from the linked account. Later features (cards, answers) register one; it never sees a stranger's update. */
type LinkedHandler = (kind: string, inbound: Inbound) => Promise<Reply>;

/** A channel as the Channels page lists it. */
interface ChannelSummary {
  kind: string;
  link: { label: string; linkedAt: number } | null;
  status: ChannelStatus;
}

type SendOutcome = { delivered: true; ref: MessageRef } | { delivered: false };

export interface Channels {
  /** Adds an adapter; its kind must be new. Done before `start`. */
  register(channel: Channel): void;
  /** Sets what handles the linked account's updates; until then they get an empty reply. */
  handle(handler: LinkedHandler): void;
  /** Calls `listener` with the channel's kind after an account has been linked to it, so what waited for a link (open cards) can be sent. */
  onLinked(listener: (kind: string) => void): void;
  /** Starts every registered channel. */
  start(): void;
  /** Stops every registered channel. */
  stop(): Promise<void>;
  /** Every registered channel with its link, in registration order. */
  list(): ChannelSummary[];
  /** The account linked to the channel; undefined when none is, or the channel is unknown. */
  linkOf(kind: string): Account | undefined;
  /**
   * A new link code for the channel: 12 base32 characters in groups of four, such as `ABCD-EFGH-IJKL`. Only its digest is stored.
   * It works once and for 10 minutes. Creating a code restarts the channel's failed-attempt count. Throws `NotFound` for an unknown channel.
   */
  createLinkCode(kind: string): string;
  /** Deletes the channel's link; false when it had none. Throws `NotFound` for an unknown channel. */
  unlink(kind: string): boolean;
  /** A link that opens the channel's bot with the link code filled in; undefined when the channel has none. Throws `NotFound` for an unknown channel. */
  linkUrl(kind: string, code: string): string | undefined;
  /** Gives the channel its credential; see `Channel.setToken`. Throws `NotFound` for an unknown channel and for one that takes no credential. */
  setToken(kind: string, token: string): Promise<TokenOutcome>;
  /**
   * The one transport-independent handler of an update.
   * From the linked account it counts as activity and goes to the handler. From anyone else, text with the shape of a link code is an attempt
   * (it links the account when the code is valid, and replies either way); everything else gets an empty reply, changes nothing and is not an attempt.
   */
  receive(kind: string, inbound: Inbound): Promise<Reply>;
  /** Sends to the channel's linked account; `{ delivered: false }` when it has none. */
  send(kind: string, message: ChannelMessage): Promise<SendOutcome>;
  /** Edits a message the channel sent. */
  edit(kind: string, ref: MessageRef, message: ChannelMessage): Promise<void>;
  /**
   * Sends the notice to the linked account of every channel that has one, as plain text with a link to the web UI. A send that fails
   * is tried again a few times, with a doubling wait, and then logged; the promise resolves when each channel is done and never rejects,
   * so a caller that does not wait for it is never held up by a channel that is down. With no linked account nothing is sent.
   */
  notify(notice: Notice): Promise<void>;
  /**
   * Sends what a bot said to the linked account of the channel the owner is talking to it from, as plain text that starts with the bot's name
   * and links to the bot's chat. Retried and logged like a notice, resolves when done and never rejects. Nothing is sent when the channel
   * is unknown or has no linked account.
   */
  say(kind: string, reply: BotReply): Promise<void>;
}

export interface ChannelsDeps {
  db: Database;
  /** Called once for every update from a linked account, whatever it says: the owner's presence for the absence pause. */
  onActivity: () => void;
  /** The URL users reach the host at: a notice links to the web UI under it. */
  publicUrl: string;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
  /** How long to wait before a notice that failed to send is tried again, doubling each time; 2 seconds when omitted. */
  noticeRetryMs?: number;
}

/** How many times a message that failed is tried again after the first send. */
const SEND_RETRIES = 4;

const RUNNING: ChannelStatus = { state: "running", detail: null, username: null };

const LINKED =
  "Linked. This chat is now connected to Tomte. You can unlink it on the Channels page.";
const REFUSED = "That code did not work. Create a new one on the Channels page.";

/** The code in a message: `/start <code>` or the code alone, in any case, with separators and spaces; undefined when the text does not have a code's shape. */
function codeIn(text: string | undefined): string | undefined {
  if (text === undefined || text.length > MAX_CODE_TEXT) return undefined;
  const body = text.replace(/^\s*\/start(?:@\w+)?\s+/i, "");
  if (!/^[a-z2-7\s._-]+$/i.test(body)) return undefined;
  const code = body.replace(/[^a-z2-7]/gi, "").toUpperCase();
  return code.length === CODE_LENGTH ? code : undefined;
}

export function createChannels(deps: ChannelsDeps): Channels {
  const store = createChannelStore(deps.db);
  const now = deps.now ?? Date.now;
  const registry = new Map<string, Channel>();
  let handler: LinkedHandler = async () => ({});
  let linked: (kind: string) => void = () => {};
  const noticeRetryMs = deps.noticeRetryMs ?? 2000;
  /** Ends the waits of notices that are between two tries, so stopping does not wait for them. */
  const retrying = new Set<() => void>();
  let stopped = false;

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        retrying.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      retrying.add(done);
    });

  const channel = (kind: string) => {
    const found = registry.get(kind);
    if (!found) throw new NotFound(`no such channel: ${kind}`);
    return found;
  };
  const accountOf = (kind: string): Account | undefined => {
    const link = store.linkOf(kind);
    return link && { id: link.accountId, label: link.label };
  };

  const send: Channels["send"] = async (kind, message) => {
    const adapter = channel(kind);
    const to = accountOf(kind);
    if (!to) return { delivered: false };
    return { delivered: true, ref: await adapter.send(to, message) };
  };

  /** Sends to the linked account, trying again with a doubling wait when it fails and logging `what` after the last try; never rejects. */
  const deliver = async (kind: string, message: ChannelMessage, what: string) => {
    let wait = noticeRetryMs;
    for (let tried = 0; ; tried++) {
      try {
        await send(kind, message);
        return;
      } catch (e) {
        if (stopped || tried >= SEND_RETRIES) {
          console.error(
            `[channels] ${what} was not delivered to ${kind}: ${e instanceof Error ? e.message : "unknown error"}`,
          );
          return;
        }
        await pause(wait);
        wait *= 2;
      }
    }
  };

  return {
    register(c) {
      if (registry.has(c.kind)) throw new Error(`channel ${c.kind} is already registered`);
      registry.set(c.kind, c);
    },

    handle(h) {
      handler = h;
    },

    onLinked(listener) {
      linked = listener;
    },

    start() {
      stopped = false;
      for (const c of registry.values()) c.start();
    },

    async stop() {
      stopped = true;
      for (const done of retrying) done();
      await Promise.all([...registry.values()].map((c) => c.stop()));
    },

    list() {
      return [...registry.entries()].map(([kind, c]) => {
        const link = store.linkOf(kind);
        return {
          kind,
          link: link ? { label: link.label, linkedAt: link.linkedAt } : null,
          status: c.status?.() ?? RUNNING,
        };
      });
    },

    linkUrl: (kind, code) => channel(kind).linkUrl?.(code),

    async setToken(kind, token) {
      const adapter = channel(kind);
      if (!adapter.setToken) throw new NotFound(`channel ${kind} takes no token`);
      return adapter.setToken(token);
    },

    linkOf: accountOf,

    createLinkCode(kind) {
      channel(kind);
      // 256 is a multiple of 32, so masking a byte to five bits picks each character evenly.
      const code = Array.from(randomBytes(CODE_LENGTH), (b) => BASE32[b & 31]).join("");
      store.addCode(kind, code, now());
      return code.match(new RegExp(`.{${GROUP}}`, "g"))!.join("-");
    },

    unlink(kind) {
      channel(kind);
      return store.unlink(kind);
    },

    async receive(kind, inbound) {
      channel(kind);
      if (store.linkOf(kind)?.accountId === inbound.from.id) {
        deps.onActivity();
        return handler(kind, inbound);
      }
      const code = codeIn(inbound.text);
      if (code === undefined) return {};
      const linkedNow = store.link(kind, code, inbound.from, now());
      // After the reply below reached the adapter's sender, so the confirmation comes before the cards that waited for the link.
      if (linkedNow) setTimeout(() => linked(kind), 0);
      return { send: [{ text: linkedNow ? LINKED : REFUSED }] };
    },

    send,

    edit: (kind, ref, message) => channel(kind).edit(ref, message),

    async notify(notice) {
      const message = noticeMessage(notice, deps.publicUrl);
      await Promise.all(
        [...registry.keys()]
          .filter((kind) => store.linkOf(kind) !== undefined)
          .map((kind) => deliver(kind, message, `a ${notice.kind} notice`)),
      );
    },

    async say(kind, reply) {
      if (!registry.has(kind)) return;
      await deliver(kind, replyMessage(reply, deps.publicUrl), `a reply of bot ${reply.botId}`);
    },
  };
}
