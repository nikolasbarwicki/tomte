// A channel adapter for tests: it records what the host sends and edits, counts its starts and stops, and feeds updates to the host as a transport would.
// `adapters` is what `HostServerOptions.channelAdapters` takes; it hands the same channel to every host that starts, so a test can restart the host and keep one fake.
import type {
  Account,
  Channel,
  ChannelMessage,
  Channels,
  Inbound,
  MessageRef,
  Reply,
} from "../channels/index.ts";

export interface FakeChannel {
  readonly channel: Channel;
  readonly sent: { to: Account; message: ChannelMessage; ref: MessageRef }[];
  readonly edited: { ref: MessageRef; message: ChannelMessage }[];
  readonly started: () => number;
  readonly stopped: () => number;
  /** `HostServerOptions.channelAdapters`. */
  adapters(receive: Channels["receive"]): Channel[];
  /** Hands one update to the host and returns the reply it produced. */
  inject(inbound: Inbound): Promise<Reply>;
}

export function fakeChannel(kind = "fake"): FakeChannel {
  const sent: FakeChannel["sent"] = [];
  const edited: FakeChannel["edited"] = [];
  let starts = 0;
  let stops = 0;
  let receive: Channels["receive"] | undefined;
  const channel: Channel = {
    kind,
    start: () => void starts++,
    stop: async () => void stops++,
    async send(to, message) {
      const ref = `m${sent.length + 1}`;
      sent.push({ to, message, ref });
      return ref;
    },
    async edit(ref, message) {
      edited.push({ ref, message });
    },
  };
  return {
    channel,
    sent,
    edited,
    started: () => starts,
    stopped: () => stops,
    adapters(r) {
      receive = r;
      return [channel];
    },
    inject(inbound) {
      if (!receive) throw new Error("the host has not asked for adapters yet");
      return receive(kind, inbound);
    },
  };
}
