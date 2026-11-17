import type { ChatMode, ServerEvent } from "@tomte/contract/events";

import type { HandoffStore } from "../store.ts";

/** An A2A agent card: how a bot describes itself to other bots. */
type AgentCard = {
  id: string;
  name: string;
  description: string;
  status: "idle" | "working";
};

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
  /** Whether the call comes from a scheduled run (a routine turn or a headless run) right now; checked on every call. Never true for an attended lease (a double-loop front). */
  unattended(): boolean;
  /** Creates a bot the way the create-bot route does, with the memory seed written and the chat mode set; the browser is off. */
  createBot(spec: NewBotSpec): { id: string; name: string; chatMode: ChatMode };
}

interface NewBotSpec {
  name: string;
  purpose: string;
  /** Written to the new bot's memory; blank writes nothing. */
  memory: string;
  chatMode: ChatMode;
}

export type HandoffCard = Extract<ServerEvent, { type: "handoff" }>;
