import { ChannelLinkCodeResponse, ChannelList } from "@claudebot/contract/api";

import { act, errorOf, post, readJson } from "@/host/api.ts";

/** The registered channels and their links; throws the host's error message when the request fails. */
export async function listChannels(): Promise<ChannelList> {
  const res = await post("/api/channels/list", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, ChannelList);
}

/** A new single-use link code for the channel; throws the host's error message when the request fails. */
export async function createLinkCode(channel: string): Promise<string> {
  const res = await post("/api/channels/link-code", { channel });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await readJson(res, ChannelLinkCodeResponse)).code;
}

export const unlinkChannel = (channel: string) => act("/api/channels/unlink", { channel });
