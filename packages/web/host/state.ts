import type { HostInfo, PublicHostInfo } from "@tomte/contract/api";
import type {
  BotSummary,
  ContextEvent,
  FilesEvent,
  HostEvent as StreamEvent,
  Integration,
  MemoryScope,
  Presence,
  RoutinesEvent,
  ServerEvent,
  WorkEvent,
} from "@tomte/contract/events";

import { reduce, type Item } from "./transcript.ts";

/** What the host last reported about one window of the subscription's rate limit. */
export type RateLimit = Extract<ServerEvent, { type: "rate_limit" }>;

/** `host-info` carries the `/api/info` response and `public-info` the `/api/host-info` response; neither is named `info`, which the contract uses for a chat line. */
export type HostEvent =
  | StreamEvent
  | { type: "host-info"; info: HostInfo }
  | { type: "public-info"; info: PublicHostInfo };

/** What the host has streamed to the page. */
export type HostState = {
  info: HostInfo | undefined;
  /** What the host says it can do; undefined until `/api/host-info` answers, which counts as nothing being available. */
  publicInfo: PublicHostInfo | undefined;
  /** Undefined until the host's first bots event arrives. */
  bots: BotSummary[] | undefined;
  /** The bot whose chat the host is streaming; `chat`, `memory`, `files`, `routines` and `work` describe it. */
  openBotId: string | undefined;
  chat: {
    items: Item[];
    /** A standard bot's turn is running. A double-loop bot never sets it from a turn: it shows `presence`. */
    busy: boolean;
    /** What a double-loop bot's presence line shows; `idle` for every other bot. */
    presence: Presence;
    context: ContextEvent | undefined;
    /** The subscription's rate limit per window, as the host last reported it; only a double-loop bot is sent any. */
    rateLimits: Record<string, RateLimit>;
  };
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines: RoutinesEvent | undefined;
  work: WorkEvent | undefined;
  integrations: Integration[];
};

export const initialHostState: HostState = {
  info: undefined,
  publicInfo: undefined,
  bots: undefined,
  openBotId: undefined,
  chat: { items: [], busy: false, presence: "idle", context: undefined, rateLimits: {} },
  memory: { user: "", bot: "" },
  files: { type: "files", dir: "", files: [] },
  routines: undefined,
  work: undefined,
  integrations: [],
};

/** Folds one event into the state. Slices the event does not touch keep their reference. */
export function applyEvent(s: HostState, e: HostEvent): HostState {
  switch (e.type) {
    case "host-info":
      return { ...s, info: e.info };
    case "public-info":
      return { ...s, publicInfo: e.info };
    case "integrations":
      return { ...s, integrations: e.integrations };
    case "memory":
      return { ...s, memory: { ...s.memory, [e.scope]: e.text } };
    case "files":
      return { ...s, files: e };
    case "routines":
      return { ...s, routines: e };
    case "work":
      return { ...s, work: e };
    case "bots":
      return { ...s, bots: e.bots };
    case "reset":
      return {
        ...s,
        openBotId: e.botId,
        chat: { items: [], busy: false, presence: "idle", context: undefined, rateLimits: {} },
      };
    case "context":
      return { ...s, chat: { ...s.chat, context: e } };
    case "presence":
      return { ...s, chat: { ...s.chat, presence: e.state } };
    case "rate_limit":
      return {
        ...s,
        chat: { ...s.chat, rateLimits: { ...s.chat.rateLimits, [e.window ?? ""]: e } },
      };
    default:
      return { ...s, chat: applyChatEvent(s.chat, e) };
  }
}

function applyChatEvent(
  chat: HostState["chat"],
  e: Exclude<ServerEvent, { type: "reset" | "context" | "presence" | "rate_limit" }>,
): HostState["chat"] {
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
