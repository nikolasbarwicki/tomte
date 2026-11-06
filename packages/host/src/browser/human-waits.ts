import { randomUUID } from "node:crypto";

import type { ServerEvent, WaitAction } from "@claudebot/contract/events";

/** What the bot's tool returns for a human wait: at once, never after the user answers. */
export interface WaitingForUser {
  status: "waiting_for_user";
  id: string;
}

export interface WaitSpec {
  /** A short label the card uses to pick its look, such as "takeover" or "approval". */
  kind: string;
  title: string;
  detail?: string;
  /** The buttons, first is the main one. */
  actions: WaitAction[];
  /** The message sent into the bot's session once the user picked `actionId`, or the wait ended as "timeout". */
  resume(outcome: string): string;
  /** Runs before the resume message is sent, for every way the wait can end, including "cancelled". */
  onResolve?(outcome: string): void;
}

export interface HumanWaitsOptions {
  /** Shows or updates the card in the bot's chat. */
  emit(botId: string, event: WaitCardEvent): void;
  /** Sends a host message into the bot's session through the normal send path: queued while the bot is busy, reopening a closed session. */
  deliver(botId: string, text: string): void;
}

export type WaitCardEvent = Extract<ServerEvent, { type: "wait" | "wait_resolved" }>;

interface Pending {
  botId: string;
  spec: WaitSpec;
  card: Extract<WaitCardEvent, { type: "wait" }>;
}

export const CANCELLED = "cancelled";

/**
 * Asks the user something without ever blocking a bot's tool call. `request` returns `{status, id}` at once
 * and the card appears in the bot's chat; when the user answers, the host sends the bot a message and runs
 * `onResolve`. Pending waits live in memory only; a host restart drops them, and the bot's session no longer
 * expects an answer.
 */
export interface HumanWaits {
  request(botId: string, spec: WaitSpec): WaitingForUser;
  /** The user's answer from the card. False when the wait is gone or `actionId` is not one of its buttons. */
  answer(id: string, actionId: string): boolean;
  /** Ends a wait for a reason that is not a button, such as "timeout". False when the wait is gone. */
  resolve(id: string, outcome: string): boolean;
  /** Ends every wait of a bot as cancelled and tells the bot why. Returns how many were pending. */
  cancelBot(botId: string, reason: string): number;
  /** The cards still waiting, to replay into a rebuilt chat. */
  pending(botId: string): WaitCardEvent[];
}

export function createHumanWaits(o: HumanWaitsOptions): HumanWaits {
  const waits = new Map<string, Pending>();

  function finish(id: string, outcome: string, message?: string): boolean {
    const w = waits.get(id);
    if (!w) return false;
    waits.delete(id);
    const label =
      w.spec.actions.find((a) => a.id === outcome)?.label ??
      (outcome === CANCELLED ? "Cancelled" : "Timed out");
    o.emit(w.botId, { type: "wait_resolved", id, label });
    w.spec.onResolve?.(outcome);
    o.deliver(
      w.botId,
      `<browser-wait-result id="${id}">\n${message ?? w.spec.resume(outcome)}\n</browser-wait-result>`,
    );
    return true;
  }

  return {
    request(botId, spec) {
      const id = randomUUID();
      const card = {
        type: "wait" as const,
        id,
        kind: spec.kind,
        title: spec.title,
        detail: spec.detail,
        actions: spec.actions,
      };
      waits.set(id, { botId, spec, card });
      o.emit(botId, card);
      return { status: "waiting_for_user", id };
    },
    answer: (id, actionId) =>
      !!waits.get(id)?.spec.actions.some((a) => a.id === actionId) && finish(id, actionId),
    resolve: (id, outcome) => finish(id, outcome),
    cancelBot(botId, reason) {
      const ids = [...waits].filter(([, w]) => w.botId === botId).map(([id]) => id);
      for (const id of ids)
        finish(
          id,
          CANCELLED,
          `Your pending request "${waits.get(id)!.spec.title}" was cancelled: ${reason}. Do not wait for it.`,
        );
      return ids.length;
    },
    pending: (botId) => [...waits.values()].filter((w) => w.botId === botId).map((w) => w.card),
  };
}
