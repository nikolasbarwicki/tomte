import { z } from "zod";

import { attachmentsOf } from "./attachments.ts";
import type { GmailApi } from "./client.ts";
import { bodyOf } from "./mail-text.ts";
import { ToolInputError } from "./tool.ts";
import { Message } from "./wire.ts";

/**
 * What a draft says, as the owner is shown it before it is sent: the headers that decide who gets it and what it is about, the text
 * body and the names of its attachments. Nothing is cut or tidied, so two drafts are equal exactly when they would go out the same.
 */
export const DraftContent = z.object({
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  body: z.string(),
  attachments: z.array(z.string()).optional(),
  thread_id: z.string().optional(),
});
export type DraftContent = z.infer<typeof DraftContent>;

const Draft = z.object({ id: z.string(), message: Message.optional() });

/** `=?UTF-8?B?…?=` and `=?UTF-8?Q?…?=` words read as text; words of another charset stay as written. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, kind: string, text: string) =>
      kind.toLowerCase() === "b"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text
              .replace(/_/g, " ")
              .replace(/=([0-9a-f]{2})/gi, (_h, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            "latin1",
          ).toString("utf8"),
    );
}

/** The draft `id` as Gmail holds it now. */
export async function draftContent(api: GmailApi, id: string): Promise<DraftContent> {
  const draft = Draft.parse(
    await api.call(
      "drafts.get",
      { path: `drafts/${encodeURIComponent(id)}`, query: { format: "full" } },
      id,
    ),
  );
  const { message } = draft;
  if (!message?.payload) throw new ToolInputError(`draft ${id} has no message to send`);
  const header = (name: string) => {
    const v = message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
    return v === undefined ? {} : { [name]: decodeWords(v) };
  };
  const files = attachmentsOf(message.payload).map((a) => a.name);
  return DraftContent.parse({
    ...header("to"),
    ...header("cc"),
    ...header("bcc"),
    ...header("subject"),
    body: bodyOf(message.payload).replace(/\r\n/g, "\n"),
    ...(files.length > 0 && { attachments: files }),
    ...(message.threadId !== undefined && { thread_id: message.threadId }),
  });
}

/** True when both would go out the same: a fixed field order, so the order of keys in either does not matter. */
export const sameDraft = (a: DraftContent, b: DraftContent): boolean => {
  const key = (c: DraftContent) =>
    JSON.stringify([c.to, c.cc, c.bcc, c.subject, c.body, c.attachments, c.thread_id]);
  return key(a) === key(b);
};
