import { z } from "zod";

import type { GmailApi } from "./client.ts";
import { rawOf } from "./mime.ts";
import { ToolInputError } from "./tool.ts";
import { Thread } from "./wire.ts";

/** The input every tool that composes a message takes: the same fields for a draft now and a send later. */
export const COMPOSE_INPUT = {
  to: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe("Recipients: `anna@example.com` or `Anna <anna@example.com>`"),
  cc: z.array(z.string()).max(50).optional().describe("Cc recipients"),
  bcc: z.array(z.string()).max(50).optional().describe("Bcc recipients"),
  subject: z
    .string()
    .max(998)
    .optional()
    .describe(
      "Required for a new message; a reply in a thread defaults to `Re: <the thread's subject>`",
    ),
  body: z.string().max(200_000).describe("The message as plain text"),
  thread_id: z
    .string()
    .optional()
    .describe("Reply in this thread: the message is threaded under the thread's latest message"),
};

export type ComposeInput = z.infer<z.ZodObject<typeof COMPOSE_INPUT>>;

const headerOf = (headers: { name: string; value: string }[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name)?.value;

/**
 * Gmail's message resource for `input`: the `raw` RFC 2822 text and, for a reply, the thread it belongs to. A reply carries
 * In-Reply-To and References from the thread's latest message so mail clients thread it.
 */
export async function composeMessage(
  api: GmailApi,
  input: ComposeInput,
): Promise<{ raw: string; threadId?: string }> {
  let subject = input.subject;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (input.thread_id !== undefined) {
    const thread = Thread.parse(
      await api.call(
        "threads.get",
        {
          path: `threads/${encodeURIComponent(input.thread_id)}`,
          query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"] },
        },
        input.thread_id,
      ),
    );
    const last = thread.messages?.at(-1);
    if (!last) throw new ToolInputError(`thread ${input.thread_id} has no messages to reply to`);
    const headers = last.payload?.headers;
    const original = headerOf(headers, "subject") ?? "";
    subject ??= /^re:/i.test(original.trim()) ? original : `Re: ${original}`.trimEnd();
    inReplyTo = headerOf(headers, "message-id");
    references = [headerOf(headers, "references"), inReplyTo].filter(Boolean).join(" ");
  }
  if (subject === undefined)
    throw new ToolInputError("a message needs a subject unless it replies in a thread");
  return {
    raw: rawOf({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      body: input.body,
      inReplyTo,
      references,
    }),
    ...(input.thread_id !== undefined && { threadId: input.thread_id }),
  };
}
