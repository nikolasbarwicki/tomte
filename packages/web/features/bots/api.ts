import { ToolAllowances } from "@claudebot/contract/api";
import type { BotAvatar } from "@claudebot/contract/avatars";

import { act, errorOf, post, readJson } from "@/host/api.ts";

export const createBot = (bot: { name: string; purpose: string } & BotAvatar) =>
  post("/api/bots/new", bot);

export const deleteFile = (path: string) => act("/api/files/delete", { path });

/** Shows `path` in Finder, or opens the bot's output folder when omitted. */
export const revealFile = (path?: string) =>
  act("/api/files/reveal", path === undefined ? {} : { path });

/** Where the browser fetches `path` as a download; the session cookie authenticates the request. */
export const downloadUrl = (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`;

/** The tools `botId` is always allowed to use, or why they could not be read. */
export async function fetchAllowances(botId: string): Promise<ToolAllowances | { error: string }> {
  const res = await post("/api/bots/allowances", { botId });
  return res.ok ? readJson(res, ToolAllowances) : { error: await errorOf(res) };
}

/** Takes back an always-allow rule; the bot's next call to the tool asks again. */
export const removeAllowance = (botId: string, tool: string) =>
  act("/api/bots/allowances/remove", { botId, tool });
