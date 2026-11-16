import type { ChannelMessage } from "../types.ts";
import type { CardItem } from "./types.ts";

/** How much of a card's heading and body is kept; a channel's own limit (Telegram's is 4096) stays well above it. */
const MAX_CARD_TEXT = 3000;

/** Telegram's limit for a button's data, in bytes; a channel's own is no larger. */
const MAX_DATA_BYTES = 64;
const MAX_LABEL = 60;
const ELLIPSIS = "…";
const REPLY_HINT = "Reply to this message to answer.";

/** `text` cut to `max` characters with an ellipsis, never inside a surrogate pair; as it is when it fits. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** What a button carries back: the source's prefix, the item and the button. Ids are opaque to the channel. */
const buttonData = (prefix: string, id: string, arg: string) => `${prefix}:${id}:${arg}`;

/** The three parts of a button's data, or undefined when it is not one of ours. */
export function parseButtonData(
  data: string,
): { prefix: string; id: string; arg: string } | undefined {
  const [prefix, id, arg, ...rest] = data.split(":");
  if (!prefix || !id || arg === undefined || arg === "" || rest.length > 0) return undefined;
  return { prefix, id, arg };
}

/**
 * The link to the web UI at the item's panel, or undefined when the public URL is a loopback `http` URL: Telegram refuses a URL button that
 * points at the machine itself, and no phone could open it.
 */
export function linkTo(
  publicUrl: string,
  item: Pick<CardItem, "botId" | "panel">,
): ChannelMessage["link"] {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return undefined;
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "0.0.0.0" ||
    url.hostname.startsWith("127.");
  if (url.protocol === "http:" && loopback) return undefined;
  const path = `/bots/${encodeURIComponent(item.botId)}`;
  return {
    label: "Open in Claudebot",
    url: `${url.origin}${path}${item.panel ? `?panel=${encodeURIComponent(item.panel)}` : ""}`,
  };
}

/**
 * An open item as one message: its heading and body cut to `MAX_CARD_TEXT`, the hint when a reply answers it, one button per row (those whose
 * data would not fit a channel's limit are left out) and the link. The text is plain: whatever the item holds shows as it is.
 */
export function cardMessage(
  item: CardItem,
  prefix: string,
  link: ChannelMessage["link"],
): ChannelMessage {
  const text = cut([item.heading, item.body].filter(Boolean).join("\n\n"), MAX_CARD_TEXT);
  const buttons = item.buttons
    .map((b) => ({ label: cut(b.label, MAX_LABEL), data: buttonData(prefix, item.id, b.arg) }))
    .filter((b) => Buffer.byteLength(b.data) <= MAX_DATA_BYTES)
    .map((b) => [b]);
  return {
    text: item.reply ? `${text}\n\n${REPLY_HINT}` : text,
    ...(buttons.length > 0 && { buttons }),
    ...(link && { link }),
  };
}

/** What a card is edited to when its item closes: the heading and the outcome, with no buttons and no link. */
export const closedMessage = (heading: string, outcome: string): ChannelMessage => ({
  text: `${cut(heading, MAX_CARD_TEXT)}\n\n${outcome}`,
});
