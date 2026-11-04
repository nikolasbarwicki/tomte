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

/** A specialized agent: a chain of Claude Code sessions (`sessions`, newest last) plus its own memory. */
export type Bot = { id: string; name: string; purpose: string; createdAt: number; lastActive: number; sessions: string[] };

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
