import type { ChatMode, Presence, ServerEvent, WorkEvent } from "@claudebot/contract/events";

/** What the bot is doing for the chat: a double-loop bot says it itself, a standard bot is working while its turn runs. */
export const livePresence = (
  mode: ChatMode,
  chat: { busy: boolean; presence: Presence },
): Presence => (mode === "double_loop" ? chat.presence : chat.busy ? "working" : "idle");

type ItemKind = Extract<ServerEvent, { type: "external" }>["kind"];

/** An open `question`, `blocked`, `failed`, `done` or `stopped` event of one source: something that waits for the user. */
export type NeedsYouItem = {
  id: string;
  kind: ItemKind;
  /** The source's label. */
  source: string;
  title: string;
  options: string[];
  receivedAt: number;
};

/**
 * What a button does for an item: answers it with `message`, or fills the composer with `draft`, which answers the item once sent. The host decides where an answer goes: it resolves the bot's pending question about the item with `answer` (the message when omitted), or else sends `message` to the bot, and closes the item once the bot has it.
 */
export type ItemAction = { label: string } & (
  | { message: string; answer?: string }
  | { draft: string }
);

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

/** The labels of the sources that have items, each once, in the order of the oldest item. */
export const sourceLabels = (items: NeedsYouItem[]): string[] => [
  ...new Set(items.map((i) => i.source)),
];

/** An item's buttons, the primary one first: Enter runs it. Every message reads as something the user typed. */
export function itemActions(item: NeedsYouItem): ItemAction[] {
  const what = `${item.source}: ${item.title}`;
  switch (item.kind) {
    case "question":
      return [
        ...item.options.map((o) => ({
          label: o,
          message: `${item.source} · ${item.title}: answer '${o}'`,
          answer: o,
        })),
        {
          label: item.options.length ? "Other…" : "Answer…",
          draft: `${item.source} · ${item.title}: `,
        },
      ];
    case "blocked":
      return [
        { label: "Unblock…", draft: `${item.source} · ${item.title}: ` },
        { label: "Status", message: `Status ${what}` },
      ];
    case "failed":
      return [
        { label: "Retry", message: `Retry ${what}` },
        { label: "Skip", message: `Skip ${what}` },
      ];
    case "done":
      return [{ label: "Review", message: `Prepare the landing brief for ${item.source}` }];
    case "stopped":
      return [{ label: "Status", message: `Status ${item.source}` }];
  }
}
