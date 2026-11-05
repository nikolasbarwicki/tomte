export type ServerEvent =
  | { type: "user"; text: string }
  | { type: "text_start" }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "ask"; id: string; question: string }
  | { type: "approve"; id: string; tool: string; reason: string; input: string }
  | { type: "answered"; id: string; value: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "info"; text: string }
  | { type: "update"; text: string }
  | { type: "reset"; botId: string }
  /** A fresh Claude Code session started inside the same bot; earlier messages are no longer in context. */
  | { type: "session" }
  /** A routine's turn starts in this chat; its prompt stays hidden like other host messages. */
  | { type: "routine"; name: string; trigger: RunTrigger }
  | { type: "compacted"; trigger: "manual" | "auto"; preTokens: number }
  | ContextEvent
  | Notice;

/** External update from herdr or an omp hook; lives outside chat history. */
export type Notice = { type: "notify"; source: string; title: string; body: string; at: number };

/** Current context window usage of the open bot's session, as reported by Claude Code. */
export type ContextEvent = { type: "context"; tokens: number; max: number; percentage: number };

/** Per-bot settings the user switches on; everything is off by default. */
export type BotBrowserSettings = { enabled: boolean; headed: boolean };

/** A specialized agent: a chain of Claude Code sessions (`sessions`, newest last) plus its own memory. */
export type Bot = { id: string; name: string; purpose: string; createdAt: number; lastActive: number; sessions: string[]; browser: BotBrowserSettings };

/** Newest message in a bot's chat transcript. */
export type LastMessage = { from: "user" | "bot"; text: string; at: number };
/** `unseen`: the bot finished a turn the user has not looked at yet. */
export type BotStatus = "idle" | "working" | "unseen";
export type BotSummary = Bot & { last: LastMessage | null; status: BotStatus };
/** Every bot for the sidebar, most recently active first; lives outside chat history. */
export type BotsEvent = { type: "bots"; bots: BotSummary[] };

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
  id: string; routineId: string; trigger: RunTrigger; scheduledFor: number | null; status: RunStatus;
  sessionId: string | null; output: string | null; error: string | null; startedAt: number; finishedAt: number | null;
};
export type Routine = {
  id: string; botId: string; name: string; instruction: string; schedule: Schedule;
  active: boolean; catchUp: boolean; createdAt: number; updatedAt: number;
  /** Derived on read from schedule + lastScheduledFor; null when nothing is left to fire. */
  nextRunAt: number | null;
  lastRun: RoutineRun | null;
  running: boolean;
};
/** The open bot's routines; lives outside chat history. */
export type RoutinesEvent = { type: "routines"; botId: string; routines: Routine[] };

export type ToolPolicy = "off" | "ask" | "auto";
export type ConnState = "disconnected" | "connected" | "needs-auth" | "failed";
export type IntegrationTransport = ({ type: "http" | "sse"; url: string } | { type: "stdio"; command: string; args: string[]; envKeys: string[] }) & {
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
  name: string; description: string; readOnly: boolean; destructive: boolean; policy: ToolPolicy; lastSeen: number;
};
export type IntegrationSkill = { name: string; description: string; enabled: boolean };
export type Integration = {
  id: string; catalogId: string | null; label: string; note?: string; name: string; transport: IntegrationTransport; auth: IntegrationAuth; redirectUrl: string;
  enabled: boolean; state: ConnState; error: string | null; tools: IntegrationTool[]; skills: IntegrationSkill[]; skillsError?: string; createdAt: number; updatedAt: number;
};
/** Every integration for the Integrations screen; global, lives outside chat history. */
export type IntegrationsEvent = { type: "integrations"; integrations: Integration[] };

/** A stored website login; the password lives only in the OS keychain and is never part of any event. */
export type CredentialEntry = {
  id: string; label: string; signInUrl: string; origin: string; username: string; createdAt: number; updatedAt: number;
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
  | { type: "status"; viewport: { width: number; height: number } };
