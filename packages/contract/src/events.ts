import { z } from "zod";

import { BotAvatar } from "./avatars.ts";

const Mentions = z.array(z.object({ id: z.string(), name: z.string() }));

/** One button on a wait card. */
export const WaitAction = z.object({ id: z.string(), label: z.string() });
export type WaitAction = z.infer<typeof WaitAction>;

/** External update from herdr or an omp hook; lives outside chat history. */
export const Notice = z.object({
  type: z.literal("notify"),
  source: z.string(),
  title: z.string(),
  body: z.string(),
  at: z.number(),
});
export type Notice = z.infer<typeof Notice>;

/** Current context window usage of the open bot's session, as reported by Claude Code. */
export const ContextEvent = z.object({
  type: z.literal("context"),
  tokens: z.number(),
  max: z.number(),
  percentage: z.number(),
});
export type ContextEvent = z.infer<typeof ContextEvent>;

export const RunTrigger = z.enum(["schedule", "manual"]);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), text: z.string(), mentions: Mentions.exactOptional() }),
  /** A user message sent while the bot was busy; it waits as pending until `dequeued`, then shows as `user` if it ran. */
  z.object({
    type: z.literal("queued"),
    id: z.string(),
    text: z.string(),
    mentions: Mentions.exactOptional(),
  }),
  z.object({ type: z.literal("dequeued"), id: z.string() }),
  z.object({ type: z.literal("text_start") }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("tool"), name: z.string(), input: z.string() }),
  z.object({ type: z.literal("ask"), id: z.string(), question: z.string() }),
  z.object({
    type: z.literal("approve"),
    id: z.string(),
    tool: z.string(),
    reason: z.string(),
    input: z.string(),
  }),
  z.object({ type: z.literal("answered"), id: z.string(), value: z.string() }),
  /** The bot asked the user for something and is waiting for an answer; `wait_resolved` closes the card. */
  z.object({
    type: z.literal("wait"),
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    detail: z.string().exactOptional(),
    actions: z.array(WaitAction),
  }),
  z.object({ type: z.literal("wait_resolved"), id: z.string(), label: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("info"), text: z.string() }),
  z.object({ type: z.literal("update"), text: z.string() }),
  z.object({ type: z.literal("reset"), botId: z.string() }),
  /** A fresh Claude Code session started inside the same bot; earlier messages are no longer in context. */
  z.object({ type: z.literal("session") }),
  /** A routine's turn starts in this chat; its prompt stays hidden like other host messages. */
  z.object({ type: z.literal("routine"), name: z.string(), trigger: RunTrigger }),
  /** A handoff shown as a card. `received`: another bot's brief or update arrived; `sent`: this bot's own handoff tool call. `bot` is the other party's name, `botId` its id when the handoff is still known. */
  z.object({
    type: z.literal("handoff"),
    direction: z.enum(["sent", "received"]),
    bot: z.string(),
    botId: z.string().exactOptional(),
    title: z.string(),
    status: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("compacted"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
  }),
  ContextEvent,
  Notice,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Per-bot settings the user switches on; everything is off by default. */
export const BotBrowserSettings = z.object({ enabled: z.boolean(), headed: z.boolean() });
export type BotBrowserSettings = z.infer<typeof BotBrowserSettings>;

/** A specialized agent: a chain of Claude Code sessions (`sessions`, newest last) plus its own memory. */
export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  avatar: BotAvatar,
  createdAt: z.number(),
  lastActive: z.number(),
  sessions: z.array(z.string()),
  browser: BotBrowserSettings,
});
export type Bot = z.infer<typeof Bot>;

/** Newest message in a bot's chat transcript. */
export const LastMessage = z.object({
  from: z.enum(["user", "bot"]),
  text: z.string(),
  at: z.number(),
});
export type LastMessage = z.infer<typeof LastMessage>;
/** `unseen`: the bot finished a turn the user has not looked at yet. */
export const BotStatus = z.enum(["idle", "working", "unseen"]);
export type BotStatus = z.infer<typeof BotStatus>;
export const BotSummary = Bot.extend({ last: LastMessage.nullable(), status: BotStatus });
export type BotSummary = z.infer<typeof BotSummary>;
/** Every bot for the sidebar, most recently active first; lives outside chat history. */
export const BotsEvent = z.object({ type: z.literal("bots"), bots: z.array(BotSummary) });
export type BotsEvent = z.infer<typeof BotsEvent>;

/** Whether bots can get a browser on this host, and why not. */
export const BrowserAvailability = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), path: z.string(), source: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type BrowserAvailability = z.infer<typeof BrowserAvailability>;
/** The `/api/info` response: where the host runs and how it reaches Claude. */
export const HostInfo = z.object({
  cwd: z.string(),
  cli: z.string(),
  auth: z.string(),
  browser: BrowserAvailability,
});
export type HostInfo = z.infer<typeof HostInfo>;

/** `user`: facts/preferences about the user, shared by all bots. `bot`: how one bot should operate. */
export const MemoryScope = z.enum(["user", "bot"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** Contents of one memory file; lives outside chat history. */
export const MemoryEvent = z.object({
  type: z.literal("memory"),
  scope: MemoryScope,
  text: z.string(),
});
export type MemoryEvent = z.infer<typeof MemoryEvent>;

/** One file in a bot's files folder; `path` is relative to the folder, `/`-separated. */
export const BotFile = z.object({ path: z.string(), size: z.number(), mtime: z.number() });
export type BotFile = z.infer<typeof BotFile>;

/** Current contents of the open bot's files folder; lives outside chat history. */
export const FilesEvent = z.object({
  type: z.literal("files"),
  dir: z.string(),
  files: z.array(BotFile),
});
export type FilesEvent = z.infer<typeof FilesEvent>;

export const Schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string() }),
  z.object({ kind: z.literal("once"), at: z.number() }),
]);
export type Schedule = z.infer<typeof Schedule>;
export const RunStatus = z.enum(["running", "succeeded", "failed", "interrupted", "skipped"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string(),
  trigger: RunTrigger,
  scheduledFor: z.number().nullable(),
  status: RunStatus,
  sessionId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;
export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  instruction: z.string(),
  schedule: Schedule,
  active: z.boolean(),
  catchUp: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Derived on read from schedule + lastScheduledFor; null when nothing is left to fire. */
  nextRunAt: z.number().nullable(),
  lastRun: RoutineRun.nullable(),
  running: z.boolean(),
});
export type Routine = z.infer<typeof Routine>;
/** The open bot's routines; lives outside chat history. */
export const RoutinesEvent = z.object({
  type: z.literal("routines"),
  botId: z.string(),
  routines: z.array(Routine),
});
export type RoutinesEvent = z.infer<typeof RoutinesEvent>;

export const ToolPolicy = z.enum(["off", "ask", "auto"]);
export type ToolPolicy = z.infer<typeof ToolPolicy>;
export const ConnState = z.enum(["disconnected", "connected", "needs-auth", "failed"]);
export type ConnState = z.infer<typeof ConnState>;
/** `skillsDir`: absolute path of a local folder of skills; custom integrations only. */
export const IntegrationTransport = z.union([
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string(),
    skillsDir: z.string().exactOptional(),
  }),
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()),
    envKeys: z.array(z.string()),
    skillsDir: z.string().exactOptional(),
  }),
]);
export type IntegrationTransport = z.infer<typeof IntegrationTransport>;
/** An OAuth client the user registers with the provider, because the provider rejects dynamic registration. */
export const OwnClient = z.object({
  appLabel: z.string(),
  steps: z.array(z.string()),
  scope: z.string().exactOptional(),
});
export type OwnClient = z.infer<typeof OwnClient>;
export const IntegrationAuth = z.union([
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("bearer"),
    tokenLabel: z.string().exactOptional(),
    tokenUrl: z.string().exactOptional(),
    ownClient: OwnClient.exactOptional(),
  }),
  z.object({
    kind: z.literal("oauth"),
    client: z.literal("dcr"),
    alternative: z.object({ tokenLabel: z.string(), tokenUrl: z.string() }).exactOptional(),
  }),
  z.object({
    kind: z.literal("oauth"),
    client: z.literal("own"),
    ownClient: OwnClient,
    alternative: z.undefined().exactOptional(),
  }),
]);
export type IntegrationAuth = z.infer<typeof IntegrationAuth>;
export const IntegrationTool = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  policy: ToolPolicy,
  lastSeen: z.number(),
});
export type IntegrationTool = z.infer<typeof IntegrationTool>;
export const IntegrationSkill = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
export type IntegrationSkill = z.infer<typeof IntegrationSkill>;
/** A brand mark: one path on a 24×24 viewBox, drawn white on `color`. */
export const BrandIcon = z.object({ color: z.string(), path: z.string() });
export type BrandIcon = z.infer<typeof BrandIcon>;
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
export const CatalogCategory = z.enum(CATALOG_CATEGORIES);
export type CatalogCategory = z.infer<typeof CatalogCategory>;
/** What a built-in catalog entry adds to its integration's screen. */
export const CatalogInfo = z.object({
  category: CatalogCategory,
  /** One line on what the service gives bots. */
  tagline: z.string(),
  /** Absent when Simple Icons carries no mark for the service; the screen shows its initial instead. */
  icon: BrandIcon.exactOptional(),
  /** Prompts a bot can run once the service is connected. */
  examples: z.array(z.string()),
  /** Git repository cloned for the skills this service brings. */
  skillsRepo: z.string().exactOptional(),
});
export type CatalogInfo = z.infer<typeof CatalogInfo>;
export const Integration = z.object({
  id: z.string(),
  catalogId: z.string().nullable(),
  catalog: CatalogInfo.nullable(),
  label: z.string(),
  name: z.string(),
  transport: IntegrationTransport,
  auth: IntegrationAuth,
  redirectUrl: z.string(),
  enabled: z.boolean(),
  state: ConnState,
  error: z.string().nullable(),
  tools: z.array(IntegrationTool),
  skills: z.array(IntegrationSkill),
  skillsError: z.string().exactOptional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Integration = z.infer<typeof Integration>;
/** Every integration for the Integrations screen; global, lives outside chat history. */
export const IntegrationsEvent = z.object({
  type: z.literal("integrations"),
  integrations: z.array(Integration),
});
export type IntegrationsEvent = z.infer<typeof IntegrationsEvent>;

/** A stored website login; the password lives only in the OS keychain and is never part of any event. */
export const CredentialEntry = z.object({
  id: z.string(),
  label: z.string(),
  signInUrl: z.string(),
  origin: z.string(),
  username: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  grants: z.array(z.object({ botId: z.string(), grantedAt: z.number() })),
});
export type CredentialEntry = z.infer<typeof CredentialEntry>;
/** Every credential entry with its grants for the Credentials screen; global, lives outside chat history. */
export const CredentialsEvent = z.object({
  type: z.literal("credentials"),
  credentials: z.array(CredentialEntry),
});
export type CredentialsEvent = z.infer<typeof CredentialsEvent>;

/** One message on the page's `/api/events` stream. */
export const HostEvent = z.union([
  ServerEvent,
  MemoryEvent,
  FilesEvent,
  RoutinesEvent,
  BotsEvent,
  IntegrationsEvent,
  CredentialsEvent,
]);
export type HostEvent = z.infer<typeof HostEvent>;

/** What the Browser panel receives on its per-bot live stream. Only these shapes leave the host. */
export const LiveMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: z.enum(["stopped", "live"]) }),
  z.object({
    type: z.literal("frame"),
    data: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({ type: z.literal("url"), url: z.string() }),
  z.object({
    type: z.literal("tabs"),
    tabs: z.array(
      z.object({ id: z.string(), title: z.string(), url: z.string(), active: z.boolean() }),
    ),
  }),
  z.object({
    type: z.literal("status"),
    viewport: z.object({ width: z.number(), height: z.number() }),
  }),
  /** Who may act in the browser: the bot, the user once granted, or `draining` while the bot's last call finishes. */
  z.object({ type: z.literal("control"), holder: z.enum(["bot", "draining", "user"]) }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;
