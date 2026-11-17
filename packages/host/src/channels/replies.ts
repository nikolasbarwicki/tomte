import { linkTo } from "./cards/compose.ts";
import type { ChannelMessage } from "./types.ts";

/** What a bot said in a conversation the owner holds from a channel: the bot, and its message whole. */
export type BotReply = { botId: string; botName: string; text: string };

/**
 * The reply as one plain message: the bot's name first, then what it said, with a link button to the bot's chat unless the public URL is a
 * loopback `http` one. The channel cuts a text over its limit and keeps the link, and the message is never edited.
 */
export function replyMessage(reply: BotReply, publicUrl: string): ChannelMessage {
  const link = linkTo(publicUrl, { botId: reply.botId });
  return { text: `${reply.botName}\n\n${reply.text}`, ...(link && { link }) };
}
