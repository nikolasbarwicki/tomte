import type { BotAvatar } from "@claudebot/contract/avatars";
import { act, post } from "@/host/api.ts";

export const createBot = (bot: { name: string; purpose: string } & BotAvatar) => post("/api/bots/new", bot);

export const deleteFile = (path: string) => act("/api/files/delete", { path });

/** Shows `path` in Finder, or opens the bot's output folder when omitted. */
export const revealFile = (path?: string) => act("/api/files/reveal", path === undefined ? {} : { path });
