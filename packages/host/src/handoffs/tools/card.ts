import type { HandoffStatus } from "@claudebot/contract/events";

import type { Handoff, HandoffStore } from "../store.ts";
import type { BotsToolContext, HandoffCard } from "./context.ts";

/** Shows the caller's own handoff tool call as a card in its transcript; `h` is the handoff after the call, `text` what the caller sent. */
export function showSent(ctx: BotsToolContext, h: Handoff, text: string) {
  const other = h.requesterId === ctx.botId ? h.assigneeId : h.requesterId;
  ctx.show(ctx.botId, {
    type: "handoff",
    direction: "sent",
    bot: ctx.botName(other) ?? "A bot",
    botId: other,
    title: h.title,
    status: h.status,
    text,
  });
}

/** The same cards read back from a handoff tool call in a bot's session file, so reopened transcripts match live ones. One case per tool; a new handoff tool adds its case here next to `showSent`. */
export function sentCardsFromTool(
  tool: string,
  input: Record<string, string>,
  ownerId: string,
  deps: { handoffs: HandoffStore; botName(botId: string): string | undefined },
): HandoffCard[] {
  const name = (botId?: string) => (botId && deps.botName(botId)) || "A bot";
  if (tool === "mcp__bots__hand_off")
    return [
      {
        type: "handoff",
        direction: "sent",
        bot: name(input.to),
        ...(input.to !== undefined && { botId: input.to }),
        title: input.title ?? "",
        status: "submitted",
        text: input.brief ?? "",
      },
    ];
  const h = input.handoff_id ? deps.handoffs.get(input.handoff_id) : undefined;
  if (!h) return [];
  const card = (other: string, status: HandoffStatus, text: string): HandoffCard[] => [
    {
      type: "handoff",
      direction: "sent",
      bot: name(other),
      botId: other,
      title: h.title,
      status,
      text,
    },
  ];
  switch (tool) {
    case "mcp__bots__complete_handoff":
      return card(
        h.requesterId,
        "completed",
        deps.handoffs
          .messages(h.id)
          .filter((m) => m.kind === "result")
          .at(-1)?.text ??
          input.result ??
          "",
      );
    case "mcp__bots__fail_handoff":
      return card(h.requesterId, "failed", input.reason ?? "");
    case "mcp__bots__cancel_handoff":
      return card(h.assigneeId, "canceled", input.reason ?? "");
    case "mcp__bots__handoff_message": {
      const asAssignee = ownerId === h.assigneeId;
      return card(
        asAssignee ? h.requesterId : h.assigneeId,
        asAssignee ? "input-required" : "working",
        input.text ?? "",
      );
    }
    default:
      return [];
  }
}
