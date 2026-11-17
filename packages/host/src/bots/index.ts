import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { BotAvatar, COLOR_NAMES, defaultAvatar } from "@tomte/contract/avatars";
import {
  Bot,
  BotBrowserSettings,
  BotModel,
  ChatMode,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EffortLevel,
  type MemoryScope,
} from "@tomte/contract/events";
import { z } from "zod";

import { instructionsPath, readMemory, userMemoryPath } from "./memory.ts";
import { type HostDelegate } from "./session-kit.ts";
import { Thread, type ThreadEnv } from "./thread.ts";

export { Thread, type ThreadEnv, type TurnResult } from "./thread.ts";
export {
  TurnError,
  createUsageMeter,
  deleteBotUsage,
  sessionsOfBot,
  type TurnUsage,
  type UsageMeter,
} from "./usage.ts";
export {
  Inbox,
  MEMORY_INSTRUCTIONS,
  createCanUseTool,
  createHostMcpServer,
  memorySections,
  toolUseIdOf,
  type HostDelegate,
} from "./session-kit.ts";
export {
  instructionsPath,
  readMemory,
  userMemoryPath,
  writeMemory,
  type MemoryPaths,
} from "./memory.ts";
export { deleteActivity, getActivity, markSeen, recordMessage } from "./activity-store.ts";
export {
  allowTool,
  allowsTool,
  deleteAllowances,
  listAllowances,
  removeAllowance,
} from "./allowance-store.ts";
export {
  deleteFile,
  listFiles,
  openFileInside,
  resolveInside,
  reveal,
  watchFiles,
} from "./files.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const botsDir = (dataRoot: string) => join(dataRoot, "bots");
const botDir = (dataRoot: string, id: string) => join(botsDir(dataRoot), id);
export const botMemoryPath = (dataRoot: string, id: string) =>
  join(botDir(dataRoot, id), "memory.md");
/** Everything the bot produces for the user lives here. */
export const botFilesPath = (dataRoot: string, id: string) => join(botDir(dataRoot, id), "files");
/** The directory of every bot but `botId`, which is where a bot's memory, settings and files live and nobody else's business. */
export function otherBotDirs(dataRoot: string, botId: string): string[] {
  if (!existsSync(botsDir(dataRoot))) return [];
  return readdirSync(botsDir(dataRoot))
    .filter((id) => id !== botId)
    .map((id) => botDir(dataRoot, id));
}

/** Subfolder of the files area holding browser screenshots and oversized pages; scratch for the current session, hidden from the Files panel. */
export const BROWSER_FILES_DIR = "browser";

/** The line-drawing avatar earlier builds wrote; its stroke color carries over, its face has no counterpart. */
const LineAvatar = z.object({ face: z.string(), stroke: z.literal(COLOR_NAMES) });

/** `bot.json` as any release wrote it; files from before a field existed lack it. */
const StoredBot = Bot.extend({
  sessions: Bot.shape.sessions.min(1).optional(),
  avatar: z.union([BotAvatar, LineAvatar]).optional(),
  chatMode: ChatMode.default("standard"),
  model: BotModel.default(DEFAULT_MODEL),
  effort: EffortLevel.default(DEFAULT_EFFORT),
  browser: BotBrowserSettings.extend({ headed: z.boolean().default(false) }).default({
    enabled: false,
    headed: false,
  }),
});

function write(dataRoot: string, bot: Bot) {
  mkdirSync(botDir(dataRoot, bot.id), { recursive: true });
  writeFileSync(join(botDir(dataRoot, bot.id), "bot.json"), JSON.stringify(bot, null, 2) + "\n");
}

/** Saves a bot held in memory. Settings and the profile are owned by their setters, so a stale copy never overwrites them. */
function save(dataRoot: string, bot: Bot) {
  const stored = getBot(dataRoot, bot.id);
  if (stored) {
    bot.name = stored.name;
    bot.purpose = stored.purpose;
    bot.avatar = stored.avatar;
    bot.browser = stored.browser;
    bot.chatMode = stored.chatMode;
    bot.model = stored.model;
    bot.effort = stored.effort;
  }
  write(dataRoot, bot);
}

export function getBot(dataRoot: string, id: string): Bot | undefined {
  if (!ID.test(id)) return undefined;
  const file = join(botDir(dataRoot, id), "bot.json");
  if (!existsSync(file)) return undefined;
  const { sessions, avatar, ...bot } = StoredBot.parse(JSON.parse(readFileSync(file, "utf8")));
  return { ...bot, sessions: sessions ?? [bot.id], avatar: avatarOf(bot.id, avatar) };
}

function avatarOf(id: string, stored: z.infer<typeof StoredBot>["avatar"]): BotAvatar {
  if (!stored) return defaultAvatar(id);
  if ("shape" in stored) return stored;
  return { shape: defaultAvatar(id).shape, color: stored.stroke };
}

/** Most recently active first. */
export function listBots(dataRoot: string): Bot[] {
  if (!existsSync(botsDir(dataRoot))) return [];
  return readdirSync(botsDir(dataRoot))
    .map((id) => getBot(dataRoot, id))
    .filter((b): b is Bot => !!b)
    .sort((a, b) => b.lastActive - a.lastActive);
}

/** The bot's id doubles as its first Claude Code session id. */
export function createBot(
  dataRoot: string,
  name: string,
  purpose = "",
  id: string = randomUUID(),
  avatar: BotAvatar = defaultAvatar(id),
): Bot {
  const now = Date.now();
  const bot: Bot = {
    id,
    name: name.trim(),
    purpose: purpose.trim(),
    avatar,
    createdAt: now,
    lastActive: now,
    sessions: [id],
    chatMode: "standard",
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    browser: { enabled: false, headed: false },
  };
  save(dataRoot, bot);
  return bot;
}

/** Where deleted bots go: inside `bots/`, so isolated sessions still cannot read them, but never listed (its name is not a bot id). */
const TRASH = ".trash";

/** Moves the bot's directory (settings, memory, files) to the trash instead of deleting it; the bot is gone from the host at once. Returns the new path. */
export function trashBot(dataRoot: string, id: string): string | undefined {
  if (!getBot(dataRoot, id)) return undefined;
  const trash = join(botsDir(dataRoot), TRASH);
  mkdirSync(trash, { recursive: true });
  const to = join(trash, `${id}-${Date.now()}`);
  renameSync(botDir(dataRoot, id), to);
  return to;
}

export function setBrowserEnabled(dataRoot: string, id: string, enabled: boolean): Bot | undefined {
  const bot = getBot(dataRoot, id);
  if (!bot) return undefined;
  bot.browser.enabled = enabled;
  write(dataRoot, bot);
  return bot;
}

export function setBrowserHeaded(dataRoot: string, id: string, headed: boolean): Bot | undefined {
  const bot = getBot(dataRoot, id);
  if (!bot) return undefined;
  bot.browser.headed = headed;
  write(dataRoot, bot);
  return bot;
}

export function setChatMode(dataRoot: string, id: string, chatMode: ChatMode): Bot | undefined {
  const bot = getBot(dataRoot, id);
  if (!bot) return undefined;
  bot.chatMode = chatMode;
  write(dataRoot, bot);
  return bot;
}

/** Replaces the bot's name, purpose and avatar; the caller has validated them. */
export function setProfile(
  dataRoot: string,
  id: string,
  profile: Pick<Bot, "name" | "purpose" | "avatar">,
): Bot | undefined {
  const bot = getBot(dataRoot, id);
  if (!bot) return undefined;
  Object.assign(bot, profile);
  write(dataRoot, bot);
  return bot;
}

/** The model and effort the bot runs on: its standard turns, or the background tasks of its double-loop chat. */
export function setModelSettings(
  dataRoot: string,
  id: string,
  patch: Partial<Pick<Bot, "model" | "effort">>,
): Bot | undefined {
  const bot = getBot(dataRoot, id);
  if (!bot) return undefined;
  Object.assign(bot, patch);
  write(dataRoot, bot);
  return bot;
}

export const currentSession = (bot: Bot) => bot.sessions[bot.sessions.length - 1];

/** Start a fresh session for the bot; memory and identity carry over, the transcript does not. */
export function newSession(dataRoot: string, bot: Bot): string {
  const id = randomUUID();
  bot.sessions.push(id);
  bot.lastActive = Date.now();
  save(dataRoot, bot);
  rmSync(join(botFilesPath(dataRoot, bot.id), BROWSER_FILES_DIR), { recursive: true, force: true });
  return id;
}

export function touchBot(dataRoot: string, bot: Bot) {
  bot.lastActive = Date.now();
  save(dataRoot, bot);
}

/** The heading the user's instructions sit under in every bot's system prompt. */
const INSTRUCTIONS_HEADING = "# The user's instructions for every bot";

/** Who the bot is, as the system prompt tells every session of it, followed by the user's instructions when there are any. */
function botIdentity(dataRoot: string, bot: Bot): string[] {
  const instructions = readMemory(instructionsPath(dataRoot)).trim();
  return [
    `# This bot`,
    `You are "${bot.name}", one of several specialized bots the user runs; each bot is a single long-running conversation dedicated to its own job.`,
    bot.purpose
      ? `Your job: ${bot.purpose}`
      : "No job description was given; infer it from the conversation and bot memory.",
    ...(instructions ? ["", INSTRUCTIONS_HEADING, instructions] : []),
  ];
}

const botMemory = (dataRoot: string, id: string) => ({
  user: userMemoryPath(dataRoot),
  bot: botMemoryPath(dataRoot, id),
});

/** The bot as saved now, so a rename made since the caller read it reaches the next session; `bot` itself when it is gone. */
const freshBot = (dataRoot: string, bot: Bot) => getBot(dataRoot, bot.id) ?? bot;

/**
 * Thread options that bind a thread to a bot's identity, session, memory and files folder; user memory is the data root's.
 * The persona is computed when the session opens, from the bot and the instructions as saved then.
 */
export function botContext(dataRoot: string, bot: Bot) {
  const files = botFilesPath(dataRoot, bot.id);
  mkdirSync(files, { recursive: true });
  const persona = () =>
    [
      ...botIdentity(dataRoot, freshBot(dataRoot, bot)),
      "",
      `## Your files`,
      `Your own files folder is ${files}. The user browses it in the app's sidebar.`,
      `Save every file you produce for the user (reports, notes, drafts, exports, scripts, data, images) inside that folder, with descriptive names and subfolders when useful. Write elsewhere only when the user explicitly asks you to change files in the workspace or another location.`,
    ].join("\n");
  return {
    sessionId: currentSession(bot),
    persona,
    memory: botMemory(dataRoot, bot.id),
  };
}

/**
 * What a bot's front session binds to: the bot's identity, session and memory. The front itself has no tools to write files,
 * so its persona leaves the files folder out; the background worker writes there, so `workerPersona` is the bot's full persona
 * and `files` the folder. Both are computed when the session opens.
 */
export function frontContext(dataRoot: string, bot: Bot) {
  const full = botContext(dataRoot, bot);
  return {
    sessionId: full.sessionId,
    persona: () => botIdentity(dataRoot, freshBot(dataRoot, bot)).join("\n"),
    workerPersona: full.persona,
    files: botFilesPath(dataRoot, bot.id),
    memory: full.memory,
  };
}

/** Opens a Claude Code thread bound to a bot in the host's shared thread environment. */
export function openThread(
  {
    cwd,
    dataRoot,
    cli,
    claude,
    integrations,
    hostServers,
    botEnv,
    approveAll,
    allows,
    meter,
  }: ThreadEnv,
  bot: Bot,
  opts: {
    resume?: boolean;
    /** A session of its own instead of the bot's current one. */
    sessionId?: string;
    delegate: HostDelegate;
    log: (line: string) => void;
    idleMs?: number;
    onMemory?: (scope: MemoryScope, text: string) => void;
  },
): Thread {
  return new Thread({
    cli,
    claude,
    cwd,
    ...botContext(dataRoot, bot),
    model: bot.model,
    effort: bot.effort,
    approveAll,
    allows: (tool) => allows(bot.id, tool),
    integrations,
    hostServers: () => hostServers(bot.id),
    env: () => botEnv(bot.id),
    meter,
    botId: bot.id,
    ...opts,
  });
}
