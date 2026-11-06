import { act } from "@/host/api.ts";

export const sendMessage = (text: string, mentions: string[]) =>
  act("/api/send", { text, mentions });

export const cancelSend = (id: string) => act("/api/send/cancel", { id });

export const newSession = () => act("/api/session/new", {});

export const setModel = (model: string) => act("/api/model", { model });

export const setEffort = (effort: string) => act("/api/effort", { effort });

/** Answers a wait card with one of its action ids. */
export const answerWait = (id: string, action: string) => act("/api/waits/answer", { id, action });

/** Answers a question or permission prompt: free text, or "allow" / "deny". */
export const answer = (id: string, value: string) => act("/api/answer", { id, value });
