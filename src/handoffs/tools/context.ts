import type { ServerEvent } from "../../../web/events.ts";
import type { HandoffStore } from "../store.ts";

/** An A2A agent card: how a bot describes itself to other bots. */
export type AgentCard = { id: string; name: string; description: string; status: "idle" | "working" };

/** What every bots tool may touch; the caller's id comes from the token and is never an argument. */
export interface BotsToolContext {
  botId: string;
  handoffs: HandoffStore;
  /** The agent card of every bot, the caller included. */
  cards(): AgentCard[];
  /** A bot's name, or undefined if it does not exist. */
  botName(botId: string): string | undefined;
  /** Sends host text into a bot's session through the deliver-and-drain inbox; returns at once. */
  deliver(botId: string, text: string): void;
  /** Shows a handoff card in a bot's transcript. */
  show(botId: string, card: HandoffCard): void;
  /** A bot's files folder. */
  filesDir(botId: string): string;
}

export type HandoffCard = Extract<ServerEvent, { type: "handoff" }>;
