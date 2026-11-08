import { formatHandoff, formatHandoffUpdate } from "./format.ts";
import type { HandoffStore } from "./store.ts";

type Deps = {
  handoffs: HandoffStore;
  botName: (botId: string) => string | undefined;
  deliver: (botId: string, text: string) => void;
};

/**
 * Everything the handoffs feature holds for a bot that is being deleted: its open handoffs, in both roles, fail and the
 * other party is told why. `HostServer.removeBot` calls this beside `removeBotBrowser`.
 */
export function removeBotHandoffs(deps: Deps, botId: string): void {
  const name = deps.botName(botId) ?? "A bot";
  for (const open of deps.handoffs.openFor(botId)) {
    const text = `${name} was removed, so this handoff cannot continue.`;
    const h = deps.handoffs.transition(open.id, {
      senderId: botId,
      kind: "failure",
      text,
      status: "failed",
    });
    deps.deliver(
      h.requesterId === botId ? h.assigneeId : h.requesterId,
      formatHandoffUpdate({ id: h.id, senderName: name, status: h.status, text }),
    );
  }
}

/** On host start: re-sends each open handoff's latest message, marked resumed, to the party that owes the next step. */
export function redeliverOpenHandoffs(deps: Deps): void {
  for (const h of deps.handoffs.open()) {
    const latest = deps.handoffs.messages(h.id).at(-1);
    if (!latest) continue;
    const owed = h.status === "input-required" ? h.requesterId : h.assigneeId;
    const text =
      latest.kind === "brief"
        ? formatHandoff({
            id: h.id,
            requesterName: deps.botName(h.requesterId) ?? "A bot",
            title: h.title,
            brief: latest.text,
            resumed: true,
          })
        : formatHandoffUpdate({
            id: h.id,
            senderName: deps.botName(latest.senderId) ?? "A bot",
            status: h.status,
            text: latest.text,
            resumed: true,
          });
    deps.deliver(owed, text);
  }
}
