import type { ChannelStatus } from "@claudebot/contract/api";

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

/** What an adapter calls with each update it receives; `Channels.receive`. */
export type Receive = (kind: string, inbound: Inbound) => Promise<Reply>;

/** The outcome of giving a channel its credential (a bot token): accepted, refused by the service, or the service could not be asked. */
export type TokenOutcome = { ok: true } | { ok: false; reason: "rejected" | "unreachable" };

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
  /** What the Channels page shows about the transport; a channel without this is always running. */
  status?(): ChannelStatus;
  /** A link that opens the channel's bot with the code filled in, for channels that have one. */
  linkUrl?(code: string): string | undefined;
  /** Gives the channel its credential: checks it with the service, stores it and (re)starts the transport. Absent on a channel that needs none. */
  setToken?(token: string): Promise<TokenOutcome>;
}
