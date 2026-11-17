import { AttachResponse } from "@tomte/contract/api";
import type { Attachment, BotModel, ChatMode, EffortLevel } from "@tomte/contract/events";
import { toast } from "sonner";

import { act, errorOf, post, readJson } from "@/host/api.ts";

/** A file the user picked or dropped, with its path as picked: `report.pdf`, or `notes/june.md` inside a folder. */
export type PickedFile = { path: string; file: File };

/** The file's bytes in base64: a data URL without its prefix, which the browser encodes natively. */
function base64Of(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => {
    const url = typeof reader.result === "string" ? reader.result : "";
    resolve(url.slice(url.indexOf(",") + 1));
  };
  reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
  reader.readAsDataURL(file);
  return promise;
}

/** Saves one attachment (a file, or a folder's files) in the open bot's files folder; `undefined` when the host refused it (shown as a toast). */
export async function attach(files: PickedFile[]): Promise<Attachment | undefined> {
  const res = await post("/api/files/attach", {
    files: await Promise.all(
      files.map(async (f) => ({ path: f.path, data: await base64Of(f.file) })),
    ),
  });
  if (!res.ok) {
    toast.error(await errorOf(res));
    return undefined;
  }
  return (await readJson(res, AttachResponse)).attachment;
}

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
