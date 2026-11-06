import type { BotAvatar } from "./avatars.ts";

export type ServerEvent =
  | { type: "user"; text: string; mentions?: { id: string; name: string }[] }
  /** A user message sent while the bot was busy; it waits as pending until `dequeued`, then shows as `user` if it ran. */
  | { type: "queued"; id: string; text: string; mentions?: { id: string; name: string }[] }
  | { type: "dequeued"; id: string }
  | { type: "text_start" }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "ask"; id: string; question: string }
  | { type: "approve"; id: string; tool: string; reason: string; input: string }
  | { type: "answered"; id: string; value: string }
  /** The bot asked the user for something and is waiting for an answer; `wait_resolved` closes the card. */
  | {
      type: "wait";
      id: string;
      kind: string;
      title: string;
      detail?: string;
      actions: WaitAction[];
    }
  | { type: "wait_resolved"; id: string; label: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "info"; text: string }
  | { type: "update"; text: string }
  | { type: "reset"; botId: string }
  /** A fresh Claude Code session started inside the same bot; earlier messages are no longer in context. */
  | { type: "session" }
  /** A routine's turn starts in this chat; its prompt stays hidden like other host messages. */
  | { type: "routine"; name: string; trigger: RunTrigger }
  /** A handoff shown as a card. `received`: another bot's brief or update arrived; `sent`: this bot's own handoff tool call. `bot` is the other party's name, `botId` its id when the handoff is still known. */
  | {
      type: "handoff";
      direction: "sent" | "received";
      bot: string;
      botId?: string;
      title: string;
      status: string;
      text: string;
    }
  | { type: "compacted"; trigger: "manual" | "auto"; preTokens: number }
  | ContextEvent
  | Notice;

/** One button on a wait card. */
export type WaitAction = { id: string; label: string };

/** External update from herdr or an omp hook; lives outside chat history. */
export type Notice = { type: "notify"; source: string; title: string; body: string; at: number };

/** Current context window usage of the open bot's session, as reported by Claude Code. */
export type ContextEvent = { type: "context"; tokens: number; max: number; percentage: number };

/** Per-bot settings the user switches on; everything is off by default. */
export type BotBrowserSettings = { enabled: boolean; headed: boolean };

/** A specialized agent: a chain of Claude Code sessions (`sessions`, newest last) plus its own memory. */
export type Bot = {
  id: string;
  name: string;
  purpose: string;
  avatar: BotAvatar;
  createdAt: number;
  lastActive: number;
  sessions: string[];
  browser: BotBrowserSettings;
};

/** Newest message in a bot's chat transcript. */
export type LastMessage = { from: "user" | "bot"; text: string; at: number };
/** `unseen`: the bot finished a turn the user has not looked at yet. */
export type BotStatus = "idle" | "working" | "unseen";
export type BotSummary = Bot & { last: LastMessage | null; status: BotStatus };
/** Every bot for the sidebar, most recently active first; lives outside chat history. */
export type BotsEvent = { type: "bots"; bots: BotSummary[] };

/** Whether bots can get a browser on this host, and why not. */
export type BrowserAvailability =
  | { status: "available"; path: string; source: string }
  | { status: "unavailable"; reason: string };
/** The `/api/info` response: where the host runs and how it reaches Claude. */
export type HostInfo = { cwd: string; cli: string; auth: string; browser: BrowserAvailability };

/** `user`: facts/preferences about the user, shared by all bots. `bot`: how one bot should operate. */
export type MemoryScope = "user" | "bot";

/** Contents of one memory file; lives outside chat history. */
export type MemoryEvent = { type: "memory"; scope: MemoryScope; text: string };

/** One file in a bot's files folder; `path` is relative to the folder, `/`-separated. */
export type BotFile = { path: string; size: number; mtime: number };

/** Current contents of the open bot's files folder; lives outside chat history. */
export type FilesEvent = { type: "files"; dir: string; files: BotFile[] };

export type Schedule = { kind: "cron"; expr: string; tz: string } | { kind: "once"; at: number };
export type RunTrigger = "schedule" | "manual";
export type RunStatus = "running" | "succeeded" | "failed" | "interrupted" | "skipped";
export type RoutineRun = {
  id: string;
  routineId: string;
  trigger: RunTrigger;
  scheduledFor: number | null;
  status: RunStatus;
  sessionId: string | null;
  output: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};
export type Routine = {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  schedule: Schedule;
  active: boolean;
  catchUp: boolean;
  createdAt: number;
  updatedAt: number;
  /** Derived on read from schedule + lastScheduledFor; null when nothing is left to fire. */
  nextRunAt: number | null;
  lastRun: RoutineRun | null;
  running: boolean;
};
/** The open bot's routines; lives outside chat history. */
export type RoutinesEvent = { type: "routines"; botId: string; routines: Routine[] };

export type ToolPolicy = "off" | "ask" | "auto";
export type ConnState = "disconnected" | "connected" | "needs-auth" | "failed";
export type IntegrationTransport = (
  | { type: "http" | "sse"; url: string }
  | { type: "stdio"; command: string; args: string[]; envKeys: string[] }
) & {
  /** Absolute path of a local folder of skills; custom integrations only. */
  skillsDir?: string;
};
/** An OAuth client the user registers with the provider, because the provider rejects dynamic registration. */
export type OwnClient = { appLabel: string; steps: string[]; scope?: string };
export type IntegrationAuth =
  | { kind: "none" }
  | { kind: "bearer"; tokenLabel?: string; tokenUrl?: string; ownClient?: OwnClient }
  | { kind: "oauth"; client: "dcr"; alternative?: { tokenLabel: string; tokenUrl: string } }
  | { kind: "oauth"; client: "own"; ownClient: OwnClient; alternative?: undefined };
export type IntegrationTool = {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  policy: ToolPolicy;
  lastSeen: number;
};
export type IntegrationSkill = { name: string; description: string; enabled: boolean };
/** A brand mark: one path on a 24×24 viewBox, drawn white on `color`. */
export type BrandIcon = { color: string; path: string };
/** Where a built-in sits on the Integrations list, in display order. */
export const CATALOG_CATEGORIES = [
  "Engineering",
  "Cloud and data",
  "Productivity",
  "Communication",
  "Sales and payments",
  "Design",
  "Web",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
/** What a built-in catalog entry adds to its integration's screen. */
export type CatalogInfo = {
  category: CatalogCategory;
  /** One line on what the service gives bots. */
  tagline: string;
  /** Absent when Simple Icons carries no mark for the service; the screen shows its initial instead. */
  icon?: BrandIcon;
  /** Prompts a bot can run once the service is connected. */
  examples: string[];
  /** Git repository cloned for the skills this service brings. */
  skillsRepo?: string;
};
export type Integration = {
  id: string;
  catalogId: string | null;
  catalog: CatalogInfo | null;
  label: string;
  name: string;
  transport: IntegrationTransport;
  auth: IntegrationAuth;
  redirectUrl: string;
  enabled: boolean;
  state: ConnState;
  error: string | null;
  tools: IntegrationTool[];
  skills: IntegrationSkill[];
  skillsError?: string;
  createdAt: number;
  updatedAt: number;
};
/** Every integration for the Integrations screen; global, lives outside chat history. */
export type IntegrationsEvent = { type: "integrations"; integrations: Integration[] };

/** A stored website login; the password lives only in the OS keychain and is never part of any event. */
export type CredentialEntry = {
  id: string;
  label: string;
  signInUrl: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  grants: { botId: string; grantedAt: number }[];
};
/** Every credential entry with its grants for the Credentials screen; global, lives outside chat history. */
export type CredentialsEvent = { type: "credentials"; credentials: CredentialEntry[] };

/** What the Browser panel receives on its per-bot live stream. Only these shapes leave the host. */
export type LiveMessage =
  | { type: "state"; state: "stopped" | "live" }
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "url"; url: string }
  | { type: "tabs"; tabs: { id: string; title: string; url: string; active: boolean }[] }
  | { type: "status"; viewport: { width: number; height: number } }
  /** Who may act in the browser: the bot, the user once granted, or `draining` while the bot's last call finishes. */
  | { type: "control"; holder: "bot" | "draining" | "user" };
