import type {
  BotsEvent,
  BotSummary,
  ContextEvent,
  CredentialEntry,
  CredentialsEvent,
  FilesEvent,
  HostInfo,
  Integration,
  IntegrationsEvent,
  MemoryEvent,
  MemoryScope,
  Notice,
  RoutinesEvent,
  ServerEvent,
} from "@claudebot/contract/events";
import { reduce, type Item } from "./transcript.ts";

export type StreamEvent = ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent;
/** `host-info` carries the `/api/info` response; it is not named `info`, which the contract uses for a chat line. */
export type HostEvent = StreamEvent | { type: "host-info"; info: HostInfo };

/** What the host has streamed to the page. */
export type HostState = {
  info: HostInfo | undefined;
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
  /** Newest first, capped at `NOTICE_LIMIT`. */
  notices: Notice[];
};

const NOTICE_LIMIT = 50;

export const initialHostState: HostState = {
  info: undefined,
  bots: undefined,
  openBotId: undefined,
  chat: { items: [], busy: false, context: undefined },
  memory: { user: "", bot: "" },
  files: { type: "files", dir: "", files: [] },
  routines: undefined,
  integrations: [],
  credentials: [],
  notices: [],
};

/** Folds one event into the state. Slices the event does not touch keep their reference. */
export function applyEvent(s: HostState, e: HostEvent): HostState {
  switch (e.type) {
    case "host-info":
      return { ...s, info: e.info };
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
    case "notify":
      return { ...s, notices: [e, ...s.notices].slice(0, NOTICE_LIMIT) };
    case "reset":
      return { ...s, openBotId: e.botId, chat: { items: [], busy: false, context: undefined } };
    case "context":
      return { ...s, chat: { ...s.chat, context: e } };
    default:
      return { ...s, chat: applyChatEvent(s.chat, e) };
  }
}

function applyChatEvent(chat: HostState["chat"], e: Exclude<ServerEvent, { type: "reset" | "notify" | "context" }>): HostState["chat"] {
  const context = e.type === "session" ? undefined : chat.context;
  const busy =
    e.type === "user" || e.type === "update" || e.type === "routine" || (e.type === "handoff" && e.direction === "received")
      ? true
      : e.type === "done" || e.type === "error"
        ? false
        : chat.busy;
  return { items: reduce(chat.items, e), busy, context };
}
