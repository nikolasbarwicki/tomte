import type { Database } from "bun:sqlite";

import { redeliverOpenHandoffs, removeBotHandoffs } from "./cleanup.ts";
import {
  BOTS_ENDPOINT_PATH,
  createBotsEndpoint,
  type BotsEndpoint,
  type BotsEndpointDeps,
} from "./endpoint.ts";
import { handoffIdsIn, parseHandoffTags } from "./format.ts";
import { createHandoffStore } from "./store.ts";
import { sentCardsFromTool } from "./tools/card.ts";
import type { HandoffCard } from "./tools/context.ts";

export { BOTS_ENDPOINT_PATH, type BotsEndpoint };
export { parseMentions, withMentions, type Mention } from "./format.ts";

export type HandoffsOptions = Omit<BotsEndpointDeps, "handoffs"> & { db: Database };

export interface Handoffs {
  /** The bots endpoint: the handoff tools served to bot sessions. */
  endpoint: BotsEndpoint;
  /** Handoff cards for the tags in a text delivered to `ownerId`. A brief carries its title; an update's title comes from the handoff. */
  receivedCards(text: string, ownerId: string): HandoffCard[];
  /** The cards a bot's own handoff tool call showed, read back from its session file. */
  sentCards(tool: string, input: Record<string, string>, ownerId: string): HandoffCard[];
  /** Starts the handoffs whose briefs a delivered text carries. */
  startDelivered(text: string): void;
  /** On host start: re-sends each open handoff's latest message to the party that owes the next step. */
  redeliverOpen(): void;
  /** Fails a deleted bot's open handoffs and tells the other party why. */
  removeBot(botId: string): void;
}

export function createHandoffs({ db, ...deps }: HandoffsOptions): Handoffs {
  const handoffs = createHandoffStore(db);
  const cleanup = { handoffs, botName: deps.botName, deliver: deps.deliver };
  return {
    endpoint: createBotsEndpoint({ ...deps, handoffs }),
    receivedCards: (text, ownerId) =>
      parseHandoffTags(text).map((t) => {
        const h = handoffs.get(t.id);
        return {
          type: "handoff",
          direction: "received",
          bot: t.from,
          botId: h && (h.requesterId === ownerId ? h.assigneeId : h.requesterId),
          title: t.title ?? h?.title ?? "",
          status: t.resumed && t.title !== undefined ? (h?.status ?? t.status) : t.status,
          text: t.text,
        };
      }),
    sentCards: (tool, input, ownerId) =>
      sentCardsFromTool(tool, input, ownerId, { handoffs, botName: deps.botName }),
    startDelivered(text) {
      for (const id of handoffIdsIn(text)) handoffs.start(id);
    },
    redeliverOpen: () => redeliverOpenHandoffs(cleanup),
    removeBot: (botId) => removeBotHandoffs(cleanup, botId),
  };
}
