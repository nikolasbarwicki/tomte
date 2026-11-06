import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { userMemoryPath } from "./memory.ts";
import { defaultAvatar, type BotAvatar } from "@claudebot/contract/avatars";
import type { Bot } from "@claudebot/contract/events";

export { Thread, type HostDelegate, type TurnResult } from "./thread.ts";
export { readMemory, userMemoryPath } from "./memory.ts";
export { getActivity, markSeen, recordMessage } from "./activity-store.ts";
export { deleteFile, listFiles, resolveInside, reveal, watchFiles } from "./files.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const botsDir = (dataRoot: string) => join(dataRoot, "bots");
const botDir = (dataRoot: string, id: string) => join(botsDir(dataRoot), id);
export const botMemoryPath = (dataRoot: string, id: string) => join(botDir(dataRoot, id), "memory.md");
/** Everything the bot produces for the user lives here. */
export const botFilesPath = (dataRoot: string, id: string) => join(botDir(dataRoot, id), "files");
/** Subfolder of the files area holding browser screenshots and oversized pages; scratch for the current session, hidden from the Files panel. */
export const BROWSER_FILES_DIR = "browser";

function write(dataRoot: string, bot: Bot) {
  mkdirSync(botDir(dataRoot, bot.id), { recursive: true });
  writeFileSync(join(botDir(dataRoot, bot.id), "bot.json"), JSON.stringify(bot, null, 2) + "\n");
}

/** Saves a bot held in memory. Settings are owned by their setters, so a stale copy never overwrites them. */
function save(dataRoot: string, bot: Bot) {
  const stored = getBot(dataRoot, bot.id);
  if (stored) bot.browser = stored.browser;
  write(dataRoot, bot);
}

export function getBot(dataRoot: string, id: string): Bot | undefined {
  if (!ID.test(id)) return undefined;
  const file = join(botDir(dataRoot, id), "bot.json");
  if (!existsSync(file)) return undefined;
  const bot = JSON.parse(readFileSync(file, "utf8")) as Bot;
  bot.sessions ??= [bot.id];
  bot.browser ??= { enabled: false, headed: false };
  bot.browser.headed ??= false;
  bot.avatar ??= defaultAvatar(bot.id);
  return bot;
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
export function createBot(dataRoot: string, name: string, purpose = "", id: string = randomUUID(), avatar: BotAvatar = defaultAvatar(id)): Bot {
  const now = Date.now();
  const bot: Bot = { id, name: name.trim(), purpose: purpose.trim(), avatar, createdAt: now, lastActive: now, sessions: [id], browser: { enabled: false, headed: false } };
  save(dataRoot, bot);
  return bot;
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

/** Thread options that bind a thread to a bot's identity, session, memory and files folder; user memory is the data root's. */
export function botContext(dataRoot: string, bot: Bot) {
  const files = botFilesPath(dataRoot, bot.id);
  mkdirSync(files, { recursive: true });
  const persona = [
    `# This bot`,
    `You are "${bot.name}", one of several specialized bots the user runs; each bot is a single long-running conversation dedicated to its own job.`,
    bot.purpose ? `Your job: ${bot.purpose}` : "No job description was given; infer it from the conversation and bot memory.",
    "",
    `## Your files`,
    `Your own files folder is ${files}. The user browses it in the app's sidebar.`,
    `Save every file you produce for the user (reports, notes, drafts, exports, scripts, data, images) inside that folder, with descriptive names and subfolders when useful. Write elsewhere only when the user explicitly asks you to change files in the workspace or another location.`,
  ].join("\n");
  return {
    sessionId: currentSession(bot),
    persona,
    memory: { user: userMemoryPath(dataRoot), bot: botMemoryPath(dataRoot, bot.id) },
  };
}
