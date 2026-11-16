import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { NotFound } from "../platform/errors.ts";
import { createChannelStore } from "./store.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 12;
const GROUP = 4;
/** Longer text is never a code, so it is not normalized at all. */
const MAX_CODE_TEXT = 64;

/** A person on a channel, as the channel names them: its own stable id and a name for the Channels page. */
export type Account = { id: string; label: string };

/** A message a channel sent, in the channel's own terms and opaque to the host; an adapter reads it back to edit the message. */
export type MessageRef = string;

/** What a channel shows: plain text (never formatted), rows of buttons that come back as `Inbound.button.data` (opaque, at most 64 bytes) and one link. */
export type ChannelMessage = {
  text: string;
  buttons?: { label: string; data: string }[][];
  link?: { label: string; url: string };
};

/** One update from a channel, in the host's terms: who sent it and what they did. */
export type Inbound = {
  from: Account;
  text?: string;
  button?: { data: string; on: MessageRef };
  replyTo?: MessageRef;
};

/** What the channel sends back for one update, through the same adapter that received it. */
export type Reply = {
  toast?: string;
  send?: ChannelMessage[];
  edit?: { ref: MessageRef; message: ChannelMessage }[];
};

/**
 * A transport to one kind of account (Telegram first). The host calls `send` and `edit`; an adapter hands every update it receives to
 * `Channels.receive(kind, inbound)` and carries out the `Reply` it gets back. It is constructed with that function by the composition root.
 */
export interface Channel {
  readonly kind: string;
  /** Begins receiving; a transport detail. Never throws: a transport that cannot run reports it through its own state. */
  start(): void;
  stop(): Promise<void>;
  send(to: Account, message: ChannelMessage): Promise<MessageRef>;
  edit(ref: MessageRef, message: ChannelMessage): Promise<void>;
}

/** What handles an update from the linked account. Later features (cards, answers) register one; it never sees a stranger's update. */
type LinkedHandler = (kind: string, inbound: Inbound) => Promise<Reply>;

/** A channel as the Channels page lists it. */
interface ChannelSummary {
  kind: string;
  link: { label: string; linkedAt: number } | null;
}

type SendOutcome = { delivered: true; ref: MessageRef } | { delivered: false };

export interface Channels {
  /** Adds an adapter; its kind must be new. Done before `start`. */
  register(channel: Channel): void;
  /** Sets what handles the linked account's updates; until then they get an empty reply. */
  handle(handler: LinkedHandler): void;
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
}

export interface ChannelsDeps {
  db: Database;
  /** Called once for every update from a linked account, whatever it says, so feature 13's absence pause counts presence. */
  onActivity: () => void;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

const LINKED =
  "Linked. This chat is now connected to Claudebot. You can unlink it on the Channels page.";
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

  const channel = (kind: string) => {
    const found = registry.get(kind);
    if (!found) throw new NotFound(`no such channel: ${kind}`);
    return found;
  };
  const accountOf = (kind: string): Account | undefined => {
    const link = store.linkOf(kind);
    return link && { id: link.accountId, label: link.label };
  };

  return {
    register(c) {
      if (registry.has(c.kind)) throw new Error(`channel ${c.kind} is already registered`);
      registry.set(c.kind, c);
    },

    handle(h) {
      handler = h;
    },

    start() {
      for (const c of registry.values()) c.start();
    },

    async stop() {
      await Promise.all([...registry.values()].map((c) => c.stop()));
    },

    list() {
      return [...registry.keys()].map((kind) => {
        const link = store.linkOf(kind);
        return { kind, link: link ? { label: link.label, linkedAt: link.linkedAt } : null };
      });
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
      const linked = store.link(kind, code, inbound.from, now());
      return { send: [{ text: linked ? LINKED : REFUSED }] };
    },

    async send(kind, message) {
      const adapter = channel(kind);
      const to = accountOf(kind);
      if (!to) return { delivered: false };
      return { delivered: true, ref: await adapter.send(to, message) };
    },

    edit: (kind, ref, message) => channel(kind).edit(ref, message),
  };
}
