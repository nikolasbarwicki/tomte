/**
 * What a button does for a needs-you item: answers it with `message`, or fills the composer with `draft`, which answers the item once sent.
 * The host decides where an answer goes: it resolves the bot's pending question about the item with `answer` (the message when omitted),
 * or else sends `message` to the bot, and closes the item once the bot has it.
 */
export type ItemAction = { label: string } & (
  | { message: string; answer?: string }
  | { draft: string }
);

/** The part of an open external event its buttons depend on. `kind` is any string: a kind this function does not know has no actions. */
export type ActionableItem = {
  kind: string;
  /** The source's label. */
  source: string;
  title: string;
  options: string[];
};

/**
 * An item's buttons, the primary one first: Enter runs it in the web UI. Every message reads as something the user typed. The web UI and
 * every channel offer these, so a button means the same everywhere; a channel gives a draft action no button and tells the user to reply.
 * A kind with no entry here (one added later) has no actions: Dismiss, which is not an action, is all it offers.
 */
export function itemActions(item: ActionableItem): ItemAction[] {
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
    default:
      return [];
  }
}
