import type { Database } from "bun:sqlite";
import { BROWSER_FILES_DIR, botFilesPath, botMemoryPath, getActivity, listBots, listFiles, readMemory, userMemoryPath } from "../bots/index.ts";
import type { BotStatus, BotsEvent, FilesEvent, MemoryEvent } from "../contract/events.ts";

/** The sidebar: every bot with its latest message and whether it is working, unseen or idle. */
export const botsEvent = (cwd: string, db: Database, isWorking: (botId: string) => boolean): BotsEvent => ({
  type: "bots",
  bots: listBots(cwd).map((bot) => {
    const activity = getActivity(db, bot.id);
    const last = activity?.last ?? null;
    const status: BotStatus =
      isWorking(bot.id)
        ? "working"
        : last?.from === "bot" && last.at > (activity?.seenAt ?? 0)
          ? "unseen"
          : "idle";
    return { ...bot, last, status };
  }),
});

/** User memory, and the open bot's memory (empty when no bot is open). */
export const memoryEvents = (cwd: string, botId: string | undefined): MemoryEvent[] => [
  { type: "memory", scope: "user", text: readMemory(userMemoryPath()) },
  { type: "memory", scope: "bot", text: botId ? readMemory(botMemoryPath(cwd, botId)) : "" },
];

/** The open bot's files, without the browser's own folder. */
export const filesEvent = (cwd: string, botId: string | undefined): FilesEvent => {
  const dir = botId ? botFilesPath(cwd, botId) : "";
  return { type: "files", dir, files: dir ? listFiles(dir).filter((f) => !f.path.startsWith(`${BROWSER_FILES_DIR}/`)) : [] };
};
