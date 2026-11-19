import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import type { FollowTarget } from "./connections.ts";

/** Whether the host's event stream is being opened, is open, or is down (and being retried). */
type StreamState = "connecting" | "open" | "down";

/** What the app last heard from one followed host. `bots` and `status` are the latest of an open stream. */
export interface HostView {
  name: string;
  connection: StreamState;
  bots?: BotSummary[] | undefined;
  status?: HostStatus | undefined;
}

/** What `followHost` offers, so a test can stand in for the network. */
export type StartFollowing = (
  target: FollowTarget,
  on: {
    onOpen(): void;
    onBots(bots: BotSummary[]): void;
    onStatus(status: HostStatus): void;
    onDown(reason: string): void;
  },
) => { stop(): void };

export interface FollowedHosts {
  /** Follows exactly `targets`: a new host, or a host with a new origin or token (a restarted local host), gets a new stream; a host no longer listed loses its stream. */
  sync: (targets: readonly FollowTarget[]) => void;
  view: (id: string) => HostView | undefined;
  stop: () => void;
}

/** One event stream per target, kept apart: a host going down or being slow never touches another's view. Feeds each host's bots and status to the banner and calls `changed` after every change a tray line could show. */
export function createFollowedHosts(deps: {
  start: StartFollowing;
  banner: {
    bots(host: { id: string; name: string }, bots: BotSummary[]): void;
    status(host: { id: string; name: string }, status: HostStatus): void;
    reset(hostId: string): void;
  };
  changed(): void;
  log(message: string): void;
}): FollowedHosts {
  interface Entry {
    key: string;
    follower: { stop(): void };
    view: HostView;
  }
  const entries = new Map<string, Entry>();

  function drop(id: string): void {
    entries.get(id)?.follower.stop();
    entries.delete(id);
    deps.banner.reset(id);
  }

  function begin(target: FollowTarget, key: string): void {
    const { id, name } = target;
    const host = { id, name };
    const entry: Entry = { key, follower: { stop() {} }, view: { name, connection: "connecting" } };
    entries.set(id, entry);
    /** Applies a change unless this stream's host has since been dropped or given a new stream. */
    const update = (change: Partial<HostView>): boolean => {
      if (entries.get(id) !== entry) return false;
      entry.view = { ...entry.view, ...change };
      deps.changed();
      return true;
    };
    entry.follower = deps.start(target, {
      onOpen() {
        if (entries.get(id) !== entry) return;
        deps.banner.reset(id);
        update({ connection: "open", bots: undefined, status: undefined });
      },
      onBots(bots) {
        if (update({ bots })) deps.banner.bots(host, bots);
      },
      onStatus(status) {
        if (update({ status })) deps.banner.status(host, status);
      },
      onDown(reason) {
        if (update({ connection: "down", bots: undefined, status: undefined }))
          deps.log(`event stream of ${target.origin} (${name}) is down: ${reason}`);
      },
    });
  }

  return {
    sync(targets) {
      const wanted = new Set(targets.map((t) => t.id));
      for (const id of entries.keys()) if (!wanted.has(id)) drop(id);
      for (const target of targets) {
        const key = `${target.origin}\n${target.token}`;
        const entry = entries.get(target.id);
        if (entry?.key === key) continue;
        if (entry !== undefined) drop(target.id);
        begin(target, key);
      }
      deps.changed();
    },
    view: (id) => entries.get(id)?.view,
    stop() {
      for (const id of entries.keys()) drop(id);
    },
  };
}
