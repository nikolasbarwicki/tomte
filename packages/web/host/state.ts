import type { HostInfo, PublicHostInfo } from "@claudebot/contract/api";
import type {
  BotSummary,
  ContextEvent,
  CredentialEntry,
  FilesEvent,
  HostEvent as StreamEvent,
  Integration,
  MemoryScope,
  RoutinesEvent,
  ServerEvent,
} from "@claudebot/contract/events";

import { reduce, type Item } from "./transcript.ts";

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
  /** The bot whose chat the host is streaming; `chat`, `memory`, `files` and `routines` describe it. */
  openBotId: string | undefined;
  chat: { items: Item[]; busy: boolean; context: ContextEvent | undefined };
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines: RoutinesEvent | undefined;
  integrations: Integration[];
  credentials: CredentialEntry[];
};

export const initialHostState: HostState = {
  info: undefined,
  publicInfo: undefined,
  bots: undefined,
  openBotId: undefined,
  chat: { items: [], busy: false, context: undefined },
  memory: { user: "", bot: "" },
  files: { type: "files", dir: "", files: [] },
  routines: undefined,
  integrations: [],
  credentials: [],
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
    case "credentials":
      return { ...s, credentials: e.credentials };
    case "memory":
      return { ...s, memory: { ...s.memory, [e.scope]: e.text } };
    case "files":
      return { ...s, files: e };
    case "routines":
      return { ...s, routines: e };
    case "bots":
      return { ...s, bots: e.bots };
    case "reset":
      return { ...s, openBotId: e.botId, chat: { items: [], busy: false, context: undefined } };
    case "context":
      return { ...s, chat: { ...s.chat, context: e } };
    default:
      return { ...s, chat: applyChatEvent(s.chat, e) };
  }
}

function applyChatEvent(
  chat: HostState["chat"],
  e: Exclude<ServerEvent, { type: "reset" | "context" }>,
): HostState["chat"] {
  const context = e.type === "session" ? undefined : chat.context;
  const busy =
    e.type === "user" ||
    e.type === "routine" ||
    (e.type === "handoff" && e.direction === "received")
      ? true
      : e.type === "done" || e.type === "error"
        ? false
        : chat.busy;
  return { items: reduce(chat.items, e), busy, context };
}
