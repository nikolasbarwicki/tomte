import { ChannelLinkCodeResponse, ChannelList } from "@tomte/contract/api";

import { act, errorOf, post, readJson } from "@/host/api.ts";

/** The registered channels with their links and status; throws the host's error message when the request fails. */
export async function listChannels(): Promise<ChannelList> {
  const res = await post("/api/channels/list", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, ChannelList);
}

/** A new single-use link code for the channel and the link that opens its bot with it, if it has one; throws the host's error message when the request fails. */
export async function createLinkCode(channel: string): Promise<ChannelLinkCodeResponse> {
  const res = await post("/api/channels/link-code", { channel });
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, ChannelLinkCodeResponse);
}

export const unlinkChannel = (channel: string) => act("/api/channels/unlink", { channel });

/** Gives Telegram its bot token; the host checks it with Telegram first. Resolves to the host's reason when it is refused, undefined when it is stored. */
export async function setTelegramToken(token: string): Promise<string | undefined> {
  const res = await post("/api/channels/telegram/token", { token });
  return res.ok ? undefined : errorOf(res);
}
