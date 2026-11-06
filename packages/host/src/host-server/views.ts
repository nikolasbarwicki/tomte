import type { Database } from "bun:sqlite";

import type { BotStatus, BotsEvent, FilesEvent, MemoryEvent } from "@claudebot/contract/events";

import {
  BROWSER_FILES_DIR,
  botFilesPath,
  botMemoryPath,
  getActivity,
  listBots,
  listFiles,
  readMemory,
  userMemoryPath,
} from "../bots/index.ts";

/** The sidebar: every bot with its latest message and whether it is working, unseen or idle. */
export const botsEvent = (
  dataRoot: string,
  db: Database,
  isWorking: (botId: string) => boolean,
): BotsEvent => ({
  type: "bots",
  bots: listBots(dataRoot).map((bot) => {
    const activity = getActivity(db, bot.id);
    const last = activity?.last ?? null;
    const status: BotStatus = isWorking(bot.id)
      ? "working"
      : last?.from === "bot" && last.at > (activity?.seenAt ?? 0)
        ? "unseen"
        : "idle";
    return { ...bot, last, status };
  }),
});

/** User memory, and the open bot's memory (empty when no bot is open). */
export const memoryEvents = (dataRoot: string, botId: string | undefined): MemoryEvent[] => [
  { type: "memory", scope: "user", text: readMemory(userMemoryPath(dataRoot)) },
  { type: "memory", scope: "bot", text: botId ? readMemory(botMemoryPath(dataRoot, botId)) : "" },
];

/** The open bot's files, without the browser's own folder. */
export const filesEvent = (dataRoot: string, botId: string | undefined): FilesEvent => {
  const dir = botId ? botFilesPath(dataRoot, botId) : "";
  return {
    type: "files",
    dir,
    files: dir ? listFiles(dir).filter((f) => !f.path.startsWith(`${BROWSER_FILES_DIR}/`)) : [],
  };
};
