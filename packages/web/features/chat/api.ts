import type { BotModel, ChatMode, EffortLevel } from "@tomte/contract/events";

import { act } from "@/host/api.ts";

export const cancelSend = (id: string) => act("/api/send/cancel", { id });

export const newSession = () => act("/api/session/new", {});

/** Switches the bot's chat mode; the host starts a new session, and answers 409 while background tasks run. */
export const setChatMode = (botId: string, chatMode: ChatMode) =>
  act("/api/bots/chat-mode", { botId, chatMode });

/** Saves the open bot's model or effort; the host applies it to the running session, or to a double-loop bot's next task. */
export const setModel = (model: BotModel) => act("/api/model", { model });

export const setEffort = (effort: EffortLevel) => act("/api/effort", { effort });

/** Answers a wait card with one of its action ids. */
export const answerWait = (id: string, action: string) => act("/api/waits/answer", { id, action });

/** Answers a question or permission prompt: free text, or an action id of the card (`allow`, `allow_always`, `deny`). A note is a line for the bot. */
export const answer = (id: string, value: string, note?: string) =>
  act("/api/answer", { id, value, ...(note && { note }) });

/** Drops a needs-you item without acting on it. */
export const dismissItem = (botId: string, id: string) =>
  act("/api/bots/events/dismiss", { botId, id });
