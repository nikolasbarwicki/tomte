// The pure half of the Telegram adapter: a Telegram update to an `Inbound`, and a `Reply` or a `ChannelMessage` to Bot API calls.
// It touches no network and no state, so a webhook (Stage 3) and the cards of ticket 03 reuse it unchanged.
import { z } from "zod";

import type { Account, ChannelMessage, Inbound, MessageRef, Reply } from "../types.ts";

const User = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
const Chat = z.object({ id: z.number(), type: z.string() });
const MessageShape = z.object({
  message_id: z.number(),
  chat: Chat,
  from: User.optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number(), chat: Chat }).optional(),
});
const UpdateShape = z.object({
  update_id: z.number(),
  message: MessageShape.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: User,
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: Chat }).optional(),
    })
    .optional(),
});

/** The id of a raw update, or undefined when it has none and so cannot be confirmed. */
export function updateId(raw: unknown): number | undefined {
  const parsed = z.object({ update_id: z.number() }).safeParse(raw);
  return parsed.success ? parsed.data.update_id : undefined;
}

/** What a served update needs besides its `Inbound` to be answered: the chat to write to and, for a button press, the query to acknowledge. */
export interface Served {
  inbound: Inbound;
  chatId: number;
  callbackId?: string;
}

/** Telegram's own text limit is 4096; a message is cut well below it so a cut never depends on how Telegram counts. */
const MAX_TEXT = 4000;

/** A reference to a message: the chat and the message id, which an edit needs. Opaque to the host. */
export const refOf = (chatId: number, messageId: number): MessageRef => `${chatId}:${messageId}`;

/** The chat and message id inside a reference, or undefined when it is not one of ours. */
export function parseRef(ref: MessageRef): { chatId: number; messageId: number } | undefined {
  const m = /^(-?\d+):(\d+)$/.exec(ref);
  return m ? { chatId: Number(m[1]), messageId: Number(m[2]) } : undefined;
}

function accountOf(u: z.infer<typeof User>): Account {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  return { id: String(u.id), label: name || (u.username ? `@${u.username}` : String(u.id)) };
}

/**
 * The update as an `Inbound`, or undefined when it is not to be served: a chat that is not private (groups, channels), an edited message,
 * an update with no sender, a sender that is a bot, a button press with no message or no data, or anything of another kind or shape.
 * It judges the update's shape only; who the sender is, is `Channels.receive`'s business.
 */
export function inboundOf(raw: unknown): Served | undefined {
  const parsed = UpdateShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const { message, callback_query: query } = parsed.data;

  if (message) {
    if (message.chat.type !== "private" || !message.from || message.from.is_bot) return undefined;
    const replyTo = message.reply_to_message;
    return {
      chatId: message.chat.id,
      inbound: {
        from: accountOf(message.from),
        ...(message.text !== undefined && { text: message.text }),
        ...(replyTo && { replyTo: refOf(replyTo.chat.id, replyTo.message_id) }),
      },
    };
  }
  if (query) {
    const on = query.message;
    if (!on || on.chat.type !== "private" || query.from.is_bot || query.data === undefined)
      return undefined;
    return {
      chatId: on.chat.id,
      callbackId: query.id,
      inbound: {
        from: accountOf(query.from),
        button: { data: query.data, on: refOf(on.chat.id, on.message_id) },
      },
    };
  }
  return undefined;
}

/** Telegram shows at most 200 characters of an `answerCallbackQuery` text. */
const MAX_TOAST = 200;

/** Text below Telegram's limit, cut on a whole character with an ellipsis; Telegram refuses an empty text, so an empty one becomes a placeholder. */
export function fitText(text: string): string {
  if (text.trim() === "") return "(empty message)";
  if (text.length <= MAX_TEXT) return text;
  let end = MAX_TEXT - 1;
  // Do not split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

/** The inline keyboard of a message: its button rows, then its link as a URL button in a row of its own. */
function keyboard(message: ChannelMessage): InlineButton[][] {
  const rows = (message.buttons ?? []).map((row) =>
    row.map((b): InlineButton => ({ text: b.label, callback_data: b.data })),
  );
  if (message.link) rows.push([{ text: message.link.label, url: message.link.url }]);
  return rows;
}

/** Plain text (no `parse_mode`, so nothing in it formats), link previews off. */
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

export function sendParams(chatId: number, message: ChannelMessage): Record<string, unknown> {
  const rows = keyboard(message);
  return {
    chat_id: chatId,
    text: fitText(message.text),
    ...NO_PREVIEW,
    ...(rows.length > 0 && { reply_markup: { inline_keyboard: rows } }),
  };
}

/** An edit always states its keyboard: Telegram keeps the old buttons when `reply_markup` is left out, and an edited message must be able to lose them. */
export function editParams(
  ref: { chatId: number; messageId: number },
  message: ChannelMessage,
): Record<string, unknown> {
  return {
    chat_id: ref.chatId,
    message_id: ref.messageId,
    text: fitText(message.text),
    ...NO_PREVIEW,
    reply_markup: { inline_keyboard: keyboard(message) },
  };
}

/** One Bot API call a reply comes to. */
export type Call =
  | { method: "answerCallbackQuery"; params: Record<string, unknown> }
  | { method: "editMessageText"; params: Record<string, unknown> }
  | { method: "sendMessage"; params: Record<string, unknown> };

/**
 * The calls that carry out a reply to an update, in order: the button press is acknowledged (with the toast, if any), then edits, then sends.
 * An empty reply makes no call at all, a button press included: that is how a stranger's update stays unanswered. A reference that is not
 * a Telegram one is skipped.
 */
export function callsOf(reply: Reply, served: Pick<Served, "chatId" | "callbackId">): Call[] {
  const calls: Call[] = [];
  const edits = (reply.edit ?? []).flatMap((e) => {
    const ref = parseRef(e.ref);
    return ref ? [{ ref, message: e.message }] : [];
  });
  const sends = reply.send ?? [];
  const nonEmpty = reply.toast !== undefined || edits.length > 0 || sends.length > 0;
  if (served.callbackId !== undefined && nonEmpty)
    calls.push({
      method: "answerCallbackQuery",
      params: {
        callback_query_id: served.callbackId,
        ...(reply.toast !== undefined && { text: reply.toast.slice(0, MAX_TOAST) }),
      },
    });
  for (const e of edits)
    calls.push({ method: "editMessageText", params: editParams(e.ref, e.message) });
  for (const m of sends)
    calls.push({ method: "sendMessage", params: sendParams(served.chatId, m) });
  return calls;
}
