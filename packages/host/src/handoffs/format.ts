import { HandoffStatus } from "@claudebot/contract/events";

/** The fixed line after a brief: the tools that continue or finish the handoff. */
const HANDOFF_TOOLS_LINE =
  "Continue or finish this handoff with the bots tools (mcp__bots__*): handoff_message to ask or answer, complete_handoff with your result, fail_handoff to decline or give up.";

const attr = (s: string) =>
  s.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const open = (name: string, attrs: [string, string][], resumed?: boolean) =>
  `<${name} ${[...attrs, ...(resumed ? ([["resumed", "true"]] as [string, string][]) : [])].map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}>`;

/** The brief as delivered into the assignee's chat. */
export function formatHandoff(h: {
  id: string;
  requesterName: string;
  title: string;
  brief: string;
  resumed?: boolean;
}): string {
  return `${open(
    "handoff",
    [
      ["id", h.id],
      ["requester", h.requesterName],
      ["title", h.title],
    ],
    h.resumed,
  )}\n${h.brief}\n</handoff>\n${HANDOFF_TOOLS_LINE}`;
}

/** Any later event of a handoff (message, result, failure, cancel) as delivered to the other party. */
export function formatHandoffUpdate(u: {
  id: string;
  senderName: string;
  status: HandoffStatus;
  text: string;
  resumed?: boolean;
}): string {
  return `${open(
    "handoff-update",
    [
      ["id", u.id],
      ["from", u.senderName],
      ["status", u.status],
    ],
    u.resumed,
  )}\n${u.text}\n</handoff-update>`;
}

const unattr = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const attrsOf = (s: string): Record<string, string | undefined> =>
  Object.fromEntries(
    [...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k = "", v = ""]) => [k, unattr(v)]),
  );

/** A handoff or handoff-update message addressed to this bot, read back from its tag; `title` is only known for a brief. */
export type ReceivedHandoff = {
  id: string;
  from: string;
  title?: string;
  status: HandoffStatus;
  text: string;
  resumed?: boolean;
};

/** Every handoff tag in a delivered text (several may be joined into one turn), in order. A missing or unknown status (old or hand-edited transcripts) reads as `submitted` on a brief and `working` on an update. */
export function parseHandoffTags(text: string): ReceivedHandoff[] {
  return [...text.matchAll(/<(handoff|handoff-update) ([^>]*)>\n([\s\S]*?)\n<\/\1>/g)].map(
    ([, kind, attrs = "", body = ""]) => {
      const a = attrsOf(attrs);
      return kind === "handoff"
        ? {
            id: a.id ?? "",
            from: a.requester ?? "",
            ...(a.title !== undefined && { title: a.title }),
            status: HandoffStatus.catch("submitted").parse(a.status),
            text: body,
            resumed: a.resumed === "true",
          }
        : {
            id: a.id ?? "",
            from: a.from ?? "",
            status: HandoffStatus.catch("working").parse(a.status),
            text: body,
            resumed: a.resumed === "true",
          };
    },
  );
}

/** Ids of the handoffs whose briefs a delivered text carries. */
export const handoffIdsIn = (text: string): string[] =>
  [...text.matchAll(/^<handoff id="([^"]+)"/gm)].flatMap(([, id]) =>
    id === undefined ? [] : [id],
  );

/** The tag the host appends to a user message for each bot the user mentioned. */
const formatMention = (m: Mention) => `<mention name="${attr(m.name)}" id="${attr(m.id)}"/>`;

export type Mention = { id: string; name: string };

/** A user message as delivered: the typed text, then one mention tag per mentioned bot. */
export const withMentions = (text: string, mentions: Mention[]) =>
  [text, ...mentions.map(formatMention)].join("\n");

const MENTION_TAG = /<mention ([^>]*)\/>/g;

/** Splits a delivered user message back into what the user typed and the bots they mentioned. */
export function parseMentions(text: string): { text: string; mentions: Mention[] } {
  const mentions = [...text.matchAll(MENTION_TAG)].map(([, attrs = ""]) => {
    const a = attrsOf(attrs);
    return { id: a.id ?? "", name: a.name ?? "" };
  });
  return { text: text.replace(MENTION_TAG, "").trim(), mentions };
}
