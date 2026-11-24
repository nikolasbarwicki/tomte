import { ATTACHMENTS_DIR } from "@tomte/contract/api";
import type { Attachment, BotModel, ChatMode, EffortLevel } from "@tomte/contract/events";

import { act } from "@/host/api.ts";
import { upload, uploadAll } from "@/host/upload.ts";
import type { PickedFile } from "@/lib/picked-files.ts";

/**
 * Uploads one attachment (a file, or a folder's files) into `attachments/` of the open bot's files folder, streaming each
 * file, and resolves to where it went; `undefined` when the host refused a file (shown as a toast, and files of a folder
 * already sent stay). A folder whose name is taken becomes a new one (`notes 2`): the first file names it, the rest follow.
 */
export async function attach([first, ...rest]: PickedFile[]): Promise<Attachment | undefined> {
  if (!first) return undefined;
  const name = first.path.split("/")[0]!;
  if (!first.path.includes("/")) {
    const saved = await upload(`${ATTACHMENTS_DIR}/${first.path}`, first.file);
    return saved && { path: saved.path, folder: false };
  }
  const asked = `${ATTACHMENTS_DIR}/${name}`;
  const lead = await upload(`${ATTACHMENTS_DIR}/${first.path}`, first.file, asked);
  if (!lead) return undefined;
  const folder = lead.path.split("/").slice(0, 2).join("/");
  const results = await uploadAll(
    rest.map((f) => ({ path: `${folder}/${f.path.slice(name.length + 1)}`, file: f.file })),
    { stopOnFailure: true },
  );
  return results.every((r) => r !== undefined) ? { path: folder, folder: true } : undefined;
}

export const cancelSend = (id: string) => act("/api/send/cancel", { id });

export const newSession = () => act("/api/session/new", {});

/** Switches the bot's chat mode; the host starts a new session, and answers 409 while background tasks run. */
export const setChatMode = (botId: string, chatMode: ChatMode) =>
  act("/api/bots/chat-mode", { botId, chatMode });

/** Saves the open bot's model or effort; the host applies it to the running session, or to a background-tasks bot's next task. */
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
