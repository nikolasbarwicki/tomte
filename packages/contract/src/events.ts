import { z } from "zod";

import { BotAvatar } from "./avatars.ts";

const Mentions = z.array(z.object({ id: z.string(), name: z.string() }));

/** A file or folder the user attached to a message: `path` is relative to the bot's files folder. */
export const Attachment = z.object({ path: z.string().min(1), folder: z.boolean() });
export type Attachment = z.infer<typeof Attachment>;
const Attachments = z.array(Attachment);

/** One button on a wait card. */
export const WaitAction = z.object({ id: z.string(), label: z.string() });
export type WaitAction = z.infer<typeof WaitAction>;

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

/** A2A task states. `completed`, `failed` and `canceled` are final; A2A `rejected` is folded into `failed`. */
export const HandoffStatus = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
]);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

/**
 * What an external process reports about one event source. `progress` only refreshes the source's work snapshot and
 * never wakes the bot; every other kind does and, until the user acts on it or the source resolves it, needs the user.
 * `blocked`: the sender cannot go on until someone unblocks it; unlike `question` it offers no answers to pick from.
 * `notice` is the host's own item about itself (a paused routine): only the host raises it, no sender can post one, the bot never
 * receives it and it has no transcript row; the user can only dismiss it.
 */
export const ExternalEventKind = z.enum([
  "question",
  "blocked",
  "failed",
  "done",
  "stopped",
  "progress",
  "notice",
]);
export type ExternalEventKind = z.infer<typeof ExternalEventKind>;

/** Where an external event stands: `open` needs the user; `info` is a `progress` event, which never does. */
export const ExternalEventState = z.enum(["open", "acted", "dismissed", "resolved", "info"]);
export type ExternalEventState = z.infer<typeof ExternalEventState>;

/**
 * Whether the user's answer to an event that names a reply target reached it (ADR-0008). `pending`: the host's relay adapter
 * is running. `relayed`: it exited 0. `failed`: it did not run, failed or timed out, or the host stopped meanwhile; `error`
 * says why, in a line, and the user can retry. `attempts` counts the times it was started.
 */
export const RelayState = z.enum(["pending", "relayed", "failed"]);
export type RelayState = z.infer<typeof RelayState>;
export const Relay = z.object({
  state: RelayState,
  attempts: z.number(),
  error: z.string().exactOptional(),
});
export type Relay = z.infer<typeof Relay>;

/** The sender an external event names, for example one feature's coordinator. */
export const EventSource = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
});
export type EventSource = z.infer<typeof EventSource>;

export const WorkItemState = z.enum(["queued", "running", "review", "needs_you", "done", "failed"]);
export type WorkItemState = z.infer<typeof WorkItemState>;

/** One unit of an event source's work, such as a ticket; `group` clusters items, such as a wave. */
export const WorkItem = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  group: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  state: WorkItemState,
});
export type WorkItem = z.infer<typeof WorkItem>;

/** The latest step and items an event source reported; each new `work` replaces the previous one. */
export const WorkSnapshot = z.object({
  step: z.string().max(200),
  items: z.array(WorkItem).max(200),
});
export type WorkSnapshot = z.infer<typeof WorkSnapshot>;

/** What a double-loop bot's chat shows as its one presence line: `typing` while the front streams, `working` while background agents run. */
export const Presence = z.enum(["idle", "typing", "working"]);
export type Presence = z.infer<typeof Presence>;

/** Where a background task stands: `interrupted` marks a running task a host restart cut off, which a steer can still continue. */
export const TaskState = z.enum([
  "queued",
  "running",
  "interrupted",
  "done",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

/** When a message was written, in epoch milliseconds; replay leaves it out when the session file has no time for it. */
const SentAt = z.number().exactOptional();

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    text: z.string(),
    mentions: Mentions.exactOptional(),
    attachments: Attachments.exactOptional(),
    at: SentAt,
  }),
  /** A user message sent while the bot was busy; it waits as pending until `dequeued`, then shows as `user` if it ran. */
  z.object({
    type: z.literal("queued"),
    id: z.string(),
    text: z.string(),
    mentions: Mentions.exactOptional(),
    attachments: Attachments.exactOptional(),
  }),
  z.object({ type: z.literal("dequeued"), id: z.string() }),
  /** A reply starts; `delta`s carry its text. */
  z.object({ type: z.literal("text_start"), at: SentAt }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("tool"), name: z.string(), input: z.string() }),
  /** The bot is waiting for an answer. `eventId` names the external needs-you item the bot asked about; answering resolves it. */
  z.object({
    type: z.literal("ask"),
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).exactOptional(),
    eventId: z.string().exactOptional(),
  }),
  z.object({
    type: z.literal("approve"),
    id: z.string(),
    tool: z.string(),
    reason: z.string(),
    input: z.string(),
    /** The card's buttons, the main one first; answering one sends its `id` to `/api/answer`. */
    actions: z.array(WaitAction),
  }),
  z.object({ type: z.literal("answered"), id: z.string(), value: z.string() }),
  /** A question linked to an external event can no longer be answered, because its turn ended; the card stops offering answers. */
  z.object({ type: z.literal("ask_expired"), id: z.string() }),
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
    status: HandoffStatus,
    text: z.string(),
  }),
  /**
   * A delivered external event, as one compact row. `progress` events never wake the bot, so they never show. `source` is the
   * event source's label; `state` is what the stored event says now.
   */
  z.object({
    type: z.literal("external"),
    id: z.string(),
    kind: ExternalEventKind.exclude(["progress", "notice"]),
    source: z.string(),
    title: z.string(),
    state: ExternalEventState,
    relay: Relay.exactOptional(),
  }),
  /** A row shown earlier left `open`, or its relay moved: the user acted on or dismissed the event, its source resolved it, or the answer's relay started, finished or failed. */
  z.object({
    type: z.literal("external_state"),
    id: z.string(),
    state: ExternalEventState,
    relay: Relay.exactOptional(),
  }),
  z.object({
    type: z.literal("compacted"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
  }),
  /** A double-loop bot's presence changed; ephemeral, so it is never in the replayed history, and a page connecting is sent the current one. */
  z.object({ type: z.literal("presence"), state: Presence }),
  /**
   * A background task of a double-loop bot was queued, started, resumed or ended; each event is the task's whole current state, so a
   * later one replaces an earlier one with the same `taskId`. `findings` are what its agent verified so far, newest last, and
   * `after` is the task a queued task waits for. `queuedId` marks the start of a queued task: the row of that id is this task now.
   */
  z.object({
    type: z.literal("task"),
    taskId: z.string(),
    agentType: z.string().exactOptional(),
    model: z.string().exactOptional(),
    effort: z.string().exactOptional(),
    goal: z.string(),
    state: TaskState,
    startedAt: z.number(),
    endedAt: z.number().exactOptional(),
    after: z.string().exactOptional(),
    findings: z.array(z.string()).exactOptional(),
    queuedId: z.string().exactOptional(),
  }),
  /** The live status line of a running task, from the agent's progress summaries; ephemeral, so it is never in the replayed history. An empty `text` clears the line. */
  z.object({ type: z.literal("task_status"), taskId: z.string(), text: z.string() }),
  /**
   * The subscription's rate limit as Claude Code last reported it for one window, shown beside the context meter of a double-loop
   * bot, whose parallel agents spend the 5-hour and weekly limits faster. `window` is the CLI's `rateLimitType` (`five_hour`,
   * `seven_day`, ...; a string, so a window a newer CLI adds still parses); `utilization` is the used fraction (0 to 1) and
   * `resetsAt` when the window resets, in epoch milliseconds. Ephemeral like `presence`: never in the replayed history, and a page
   * connecting is sent the latest of each window.
   */
  z.object({
    type: z.literal("rate_limit"),
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    window: z.string().exactOptional(),
    utilization: z.number().exactOptional(),
    resetsAt: z.number().exactOptional(),
  }),
  /** A background task's result, posted whole as the bot's own message; it never enters the front session. */
  z.object({ type: z.literal("report"), taskId: z.string(), text: z.string(), at: SentAt }),
  ContextEvent,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Per-bot settings the user switches on; everything is off by default. */
export const BotBrowserSettings = z.object({ enabled: z.boolean(), headed: z.boolean() });
export type BotBrowserSettings = z.infer<typeof BotBrowserSettings>;

/** How a bot chats: `standard` is one turn per message; `double_loop` keeps a fast front session and runs heavy work in background tasks. */
export const ChatMode = z.enum(["standard", "double_loop"]);
export type ChatMode = z.infer<typeof ChatMode>;

/** The models a bot can run on, as the Claude CLI's aliases name them. */
export const BotModel = z.enum(["opus", "sonnet", "haiku"]);
export type BotModel = z.infer<typeof BotModel>;

/** The reasoning effort levels a bot can run at; the Claude Agent SDK's `EffortLevel`. */
export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** The model and effort a bot runs on until the user picks others. */
export const DEFAULT_MODEL: BotModel = "sonnet";
export const DEFAULT_EFFORT: EffortLevel = "medium";

/** A specialized agent: a chain of Claude Code sessions (`sessions`, newest last) plus its own memory. */
export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  avatar: BotAvatar,
  createdAt: z.number(),
  lastActive: z.number(),
  sessions: z.array(z.string()),
  chatMode: ChatMode,
  /** What the bot's standard turns run on; in double-loop mode, what its background tasks run on (the front's replies always come from a fast model). */
  model: BotModel,
  effort: EffortLevel,
  /** The owner's Chief of Staff: a prompt section and nothing else. At most one bot has it (`setChiefOfStaff`). */
  chiefOfStaff: z.boolean(),
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
/**
 * `needsYou`: how many items wait for the user: the bot's open external-event items plus its open human waits (an approval, a
 * question, a takeover; a question about an open external event is that event's item and is not counted twice).
 * `needsYouSources`: the labels of where they came from, newest first: an event's source, a routine's name for a wait of its
 * run, otherwise what the wait asks for. `needsYouAt`: when the newest arrived (epoch ms), 0 when none is open. The desktop
 * app's banner reads only these.
 */
export const BotSummary = Bot.extend({
  last: LastMessage.nullable(),
  status: BotStatus,
  needsYou: z.number().int().nonnegative(),
  needsYouSources: z.array(z.string()),
  needsYouAt: z.number().nonnegative(),
});
export type BotSummary = z.infer<typeof BotSummary>;
/** Every bot for the sidebar, most recently active first; lives outside chat history. */
export const BotsEvent = z.object({ type: z.literal("bots"), bots: z.array(BotSummary) });
export type BotsEvent = z.infer<typeof BotsEvent>;

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
/** `waiting`: the run's turn ended on a request to the owner (a tool approval or a question) and its session resumes with the answer. */
export const RunStatus = z.enum([
  "running",
  "waiting",
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
]);
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
  /** What the run used, summed over its turns; null when unknown (the run never reached a result, or its session's earlier cost was unknown). */
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheCreationTokens: z.number(),
    })
    .nullable(),
  /** The run's estimated cost: `total_cost_usd` at API prices, not money spent on a Claude plan. Null when unknown. */
  costUsd: z.number().nullable(),
  /** Milliseconds the run spent parked at a human wait. */
  parkedMs: z.number(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;
export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  instruction: z.string(),
  schedule: Schedule,
  active: z.boolean(),
  /** Why the host stopped the routine (`failures`: five failed runs in a row; `absence`: the owner was away); null when it is active or the owner paused it. */
  pausedReason: z.enum(["failures", "absence"]).nullable(),
  catchUp: z.boolean(),
  notifyResult: z.boolean(),
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

/** Where an event source stands, derived on the host from what it stored: a source never reports it. */
export const FeatureStatus = z.enum([
  "needs_you",
  "blocked",
  "failed",
  "running",
  "stopped",
  "done",
]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

/** One stored external event of a source, as the timeline shows it. */
export const SourceEvent = z.object({
  id: z.string(),
  kind: ExternalEventKind,
  title: z.string(),
  body: z.string().exactOptional(),
  options: z.array(z.string()).exactOptional(),
  receivedAt: z.number(),
  state: ExternalEventState,
  relay: Relay.exactOptional(),
});
export type SourceEvent = z.infer<typeof SourceEvent>;

/**
 * One event source of a bot: its latest work snapshot (`null` until an event carries one), the status the host derives
 * and its recent events, oldest first, with every open event whatever its age.
 */
export const WorkSource = z.object({
  id: z.string(),
  label: z.string(),
  status: FeatureStatus,
  lastEventAt: z.number(),
  work: WorkSnapshot.nullable(),
  events: z.array(SourceEvent),
});
export type WorkSource = z.infer<typeof WorkSource>;

/** The open bot's live event sources, most recent first; lives outside chat history. */
export const WorkEvent = z.object({
  type: z.literal("work"),
  botId: z.string(),
  sources: z.array(WorkSource),
});
export type WorkEvent = z.infer<typeof WorkEvent>;

export const ToolPolicy = z.enum(["off", "ask", "auto"]);
export type ToolPolicy = z.infer<typeof ToolPolicy>;
export const ConnState = z.enum(["disconnected", "connected", "needs-auth", "failed"]);
export type ConnState = z.infer<typeof ConnState>;
/**
 * `skillsDir`: absolute path of a local folder of skills; custom integrations only. A `builtin` transport is a server the host
 * itself runs in process, named by the service it speaks for.
 */
export const BuiltinService = z.enum(["gmail"]);
export type BuiltinService = z.infer<typeof BuiltinService>;
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
  z.object({
    type: z.literal("builtin"),
    service: BuiltinService,
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
  /** Computed from the built-in integration's definition, never stored: a locked tool always asks, so its policy is Ask or Off. */
  locked: z.boolean(),
  lastSeen: z.number(),
});
export type IntegrationTool = z.infer<typeof IntegrationTool>;
export const IntegrationSkill = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
export type IntegrationSkill = z.infer<typeof IntegrationSkill>;
/** A brand mark drawn on a 24×24 viewBox: one path, white on `color`. */
const BrandPath = z.object({ color: z.string(), path: z.string() });
/** A logo that has no single-colour mark (a full-colour or raster logo): an image the host's own origin serves, drawn as it is. */
const BrandImage = z.object({ image: z.string() });
export const BrandIcon = z.union([BrandPath, BrandImage]);
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
  /** Absent when no mark is vendored for the service; the screen shows its initial instead. */
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

/** The whole chat of the bot the host now streams, in one message: it replaces the chat the page had. Sent when the host opens a bot and to a page that connects. */
export const ChatEvent = z.object({
  type: z.literal("chat"),
  botId: z.string(),
  events: z.array(ServerEvent),
});
export type ChatEvent = z.infer<typeof ChatEvent>;

/** One message on the page's `/api/events` stream. */
export const HostEvent = z.union([
  ServerEvent,
  MemoryEvent,
  FilesEvent,
  RoutinesEvent,
  WorkEvent,
  BotsEvent,
  ChatEvent,
  IntegrationsEvent,
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
