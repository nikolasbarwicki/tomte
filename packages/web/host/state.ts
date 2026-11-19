import type { HostInfo, PublicHostInfo } from "@tomte/contract/api";
import type {
  BotSummary,
  ContextEvent,
  FilesEvent,
  HostEvent as StreamEvent,
  Integration,
  Presence,
  RoutinesEvent,
  ServerEvent,
  WorkEvent,
} from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import { reduce, type Item } from "./transcript.ts";

/** What the host last reported about one window of the subscription's rate limit. */
export type RateLimit = Extract<ServerEvent, { type: "rate_limit" }>;

/** `host-info` carries the `/api/info` response and `public-info` the `/api/host-info` response; neither is named `info`, which the contract uses for a chat line. */
export type HostEvent =
  | StreamEvent
  | { type: "host-info"; info: HostInfo }
  | { type: "public-info"; info: PublicHostInfo };

export type ChatState = {
  items: Item[];
  /** A standard bot's turn is running. A double-loop bot never sets it from a turn: it shows `presence`. */
  busy: boolean;
  /** What a double-loop bot's presence line shows; `idle` for every other bot. */
  presence: Presence;
  context: ContextEvent | undefined;
  /** The subscription's rate limit per window, as the host last reported it; only a double-loop bot is sent any. */
  rateLimits: Record<string, RateLimit>;
};

/**
 * What the page knows about one bot. It is kept after the host moves to another bot, so going back shows the bot at once while
 * the host sends it again; whatever the host sends replaces it.
 */
export type BotView = {
  /** Undefined until the host has sent this bot's chat. */
  chat: ChatState | undefined;
  /** The bot's own directions (memory scope `bot`). */
  memory: string;
  files: FilesEvent;
  routines: RoutinesEvent | undefined;
  work: WorkEvent | undefined;
};

/** What the host has streamed to the page. */
export type HostState = {
  info: HostInfo | undefined;
  /** What the host says it can do; undefined until `/api/host-info` answers, which counts as nothing being available. */
  publicInfo: PublicHostInfo | undefined;
  /** Undefined until the host's first `host-status` event arrives; it is sent on connect and again on every change. */
  hostStatus: HostStatus | undefined;
  /** Undefined until the host's first bots event arrives. */
  bots: BotSummary[] | undefined;
  /** The bot whose chat the host is streaming: chat, memory and files events are about it. */
  openBotId: string | undefined;
  views: Record<string, BotView>;
  /** What every bot knows about the user (memory scope `user`). */
  userMemory: string;
  integrations: Integration[];
};

export const emptyChat: ChatState = {
  items: [],
  busy: false,
  presence: "idle",
  context: undefined,
  rateLimits: {},
};

export const emptyView: BotView = {
  chat: undefined,
  memory: "",
  files: { type: "files", dir: "", files: [] },
  routines: undefined,
  work: undefined,
};

export const initialHostState: HostState = {
  info: undefined,
  publicInfo: undefined,
  hostStatus: undefined,
  bots: undefined,
  openBotId: undefined,
  views: {},
  userMemory: "",
  integrations: [],
};

/** Folds one event into the state. Slices the event does not touch keep their reference. */
export function applyEvent(s: HostState, e: HostEvent): HostState {
  switch (e.type) {
    case "host-info":
      return { ...s, info: e.info };
    case "public-info":
      return { ...s, publicInfo: e.info };
    case "host-status":
      return { ...s, hostStatus: e.status };
    case "integrations":
      return { ...s, integrations: e.integrations };
    case "memory":
      return e.scope === "user"
        ? { ...s, userMemory: e.text }
        : withView(s, s.openBotId, (v) => ({ ...v, memory: e.text }));
    case "files":
      return withView(s, s.openBotId, (v) => ({ ...v, files: e }));
    case "routines":
      return withView(s, e.botId, (v) => ({ ...v, routines: e }));
    case "work":
      return withView(s, e.botId, (v) => ({ ...v, work: e }));
    case "bots":
      return { ...s, bots: e.bots, views: withoutRemoved(s.views, e.bots) };
    case "chat":
      return withView({ ...s, openBotId: e.botId }, e.botId, (v) => ({
        ...v,
        chat: e.events.reduce(applyChatEvent, emptyChat),
      }));
    default:
      return withView(s, s.openBotId, (v) => ({
        ...v,
        chat: applyChatEvent(v.chat ?? emptyChat, e),
      }));
  }
}

function withView(
  s: HostState,
  botId: string | undefined,
  update: (v: BotView) => BotView,
): HostState {
  if (botId === undefined) return s;
  return { ...s, views: { ...s.views, [botId]: update(s.views[botId] ?? emptyView) } };
}

/** Drops the views of deleted bots; the same object when every view's bot is still there. */
function withoutRemoved(views: Record<string, BotView>, bots: BotSummary[]) {
  const ids = new Set(bots.map((b) => b.id));
  if (Object.keys(views).every((id) => ids.has(id))) return views;
  return Object.fromEntries(Object.entries(views).filter(([id]) => ids.has(id)));
}

function applyChatEvent(chat: ChatState, e: ServerEvent): ChatState {
  switch (e.type) {
    case "context":
      return { ...chat, context: e };
    case "presence":
      return { ...chat, presence: e.state };
    case "rate_limit":
      return { ...chat, rateLimits: { ...chat.rateLimits, [e.window ?? ""]: e } };
  }
  const context = e.type === "session" ? undefined : chat.context;
  const busy =
    e.type === "user" ||
    e.type === "routine" ||
    e.type === "external" ||
    (e.type === "handoff" && e.direction === "received")
      ? true
      : e.type === "done" || e.type === "error"
        ? false
        : chat.busy;
  return { ...chat, items: reduce(chat.items, e), busy, context };
}
