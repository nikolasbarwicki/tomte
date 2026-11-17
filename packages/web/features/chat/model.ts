import type {
  ChatMode,
  Presence,
  SourceEvent,
  WaitAction,
  WorkEvent,
} from "@tomte/contract/events";

import type { Item } from "@/host/transcript.ts";

/** What the bot is doing for the chat: a double-loop bot says it itself, a standard bot is working while its turn runs. */
export const livePresence = (
  mode: ChatMode,
  chat: { busy: boolean; presence: Presence },
): Presence => (mode === "double_loop" ? chat.presence : chat.busy ? "working" : "idle");

type ItemKind = Exclude<SourceEvent["kind"], "progress">;

/** An open `question`, `blocked`, `failed`, `done`, `stopped` or `notice` event of one source: something that waits for the user. */
export type NeedsYouItem = {
  id: string;
  kind: ItemKind;
  /** The source's label. */
  source: string;
  title: string;
  options: string[];
  receivedAt: number;
};

/** The open bot's open items, oldest first. `undefined` work, or work of another bot (a switch still arriving), has none. */
export function needsYouItems(work: WorkEvent | undefined, botId: string): NeedsYouItem[] {
  if (work?.botId !== botId) return [];
  return work.sources
    .flatMap((s) =>
      s.events.flatMap((e) =>
        e.state === "open" && e.kind !== "progress"
          ? [
              {
                id: e.id,
                kind: e.kind,
                source: s.label,
                title: e.title,
                options: e.options ?? [],
                receivedAt: e.receivedAt,
              },
            ]
          : [],
      ),
    )
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

/** A button of a request card: `value` is what the host's answer route takes (a wait's action id, "allow" or "deny", or an option's text). */
export type RequestAction = { label: string; value: string };

/** A card in the chat the bot is blocked on, unresolved: a `wait`, an `approve` or an `ask`. */
export type RequestRow = {
  kind: "wait" | "approve" | "ask";
  /** The card's id, also its wait's id on the host. */
  id: string;
  /** What kind of request it is: "Takeover", "Approval" or "Question". */
  label: string;
  title: string;
  /** The card's own buttons. A question without options has none: it is answered in its card. */
  actions: RequestAction[];
};

/** One row of the Needs you bar: an external item, or a request card of the chat. */
export type NeedsYouRow =
  | { type: "event"; item: NeedsYouItem }
  | { type: "request"; request: RequestRow };

const WAIT_LABELS: Record<string, string> = { takeover: "Takeover", approval: "Approval" };

/** The request a transcript item is while it is unresolved; none for a resolved or expired card, or any other item. */
function requestOf(item: Item): RequestRow | undefined {
  switch (item.kind) {
    case "approve":
      return item.answer !== undefined
        ? undefined
        : {
            kind: "approve",
            id: item.id,
            label: "Approval",
            title: `Allow ${item.tool}?`,
            actions: item.actions.map((a) => ({ label: a.label, value: a.id })),
          };
    case "ask":
      return item.answer !== undefined || item.expired
        ? undefined
        : {
            kind: "ask",
            id: item.id,
            label: "Question",
            title: item.question,
            actions: (item.options ?? []).map((o) => ({ label: o, value: o })),
          };
    case "wait":
      return item.resolved !== undefined
        ? undefined
        : {
            kind: "wait",
            id: item.id,
            label: WAIT_LABELS[item.waitKind] ?? item.waitKind,
            title: (item.waitKind === "takeover" && item.detail) || item.title,
            actions: item.actions.map((a) => ({ label: a.label, value: a.id })),
          };
    default:
      return undefined;
  }
}

/**
 * What the Needs you bar lists: the open external items, oldest first, then the unresolved request cards of the chat in the
 * order they came. A question about an external event is that event's item and is not listed again while the item is open.
 */
export function needsYouRows(
  work: WorkEvent | undefined,
  botId: string,
  chat: Item[],
): NeedsYouRow[] {
  const events = needsYouItems(work, botId);
  const open = new Set(events.map((i) => i.id));
  const requests = chat.flatMap((item): RequestRow[] => {
    if (item.kind === "ask" && item.eventId !== undefined && open.has(item.eventId)) return [];
    const request = requestOf(item);
    return request ? [request] : [];
  });
  return [
    ...events.map((item): NeedsYouRow => ({ type: "event", item })),
    ...requests.map((request): NeedsYouRow => ({ type: "request", request })),
  ];
}

/** The id of the transcript element that holds a request card, which the bar scrolls to. */
export const cardElementId = (requestId: string) => `card-${requestId}`;

/** The labels of what the rows are, each once, in row order: an item's source, a request's kind. */
export const rowLabels = (rows: NeedsYouRow[]): string[] => [
  ...new Set(rows.map((r) => (r.type === "event" ? r.item.source : r.request.label))),
];

/** What an answered approval card reads: the past tense of the button picked. `cancelled` and `expired` are the host's own words. */
export function approvalAnswerLabel(answer: string): string {
  switch (answer) {
    case "allow":
      return "Allowed";
    case "allow_always":
      return "Always allowed";
    case "deny":
      return "Denied";
    default:
      return answer;
  }
}

export type ApprovalButton = WaitAction & {
  /** The card's main button, the one the host listed first. */
  main: boolean;
  /** A Deny carries the one-line note the user typed beside it. */
  takesNote: boolean;
};

/** The card's buttons, from the actions the host stored with the wait. */
export const approvalButtons = (actions: WaitAction[]): ApprovalButton[] =>
  actions.map((a, i) => ({ ...a, main: i === 0, takesNote: a.id === "deny" }));
