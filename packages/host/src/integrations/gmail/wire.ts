import { z } from "zod";

/** The parts of the Gmail API's answers the tools read; anything else in an answer is ignored. */
export interface MessagePart {
  /** Where the part sits in the message (`1`, `1.2`); stable, unlike an attachment id. */
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined }
    | undefined;
  parts?: MessagePart[] | undefined;
}

const MessagePart: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(MessagePart).optional(),
  }),
);

export const Message = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: MessagePart.optional(),
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
  id: z.string(),
  messages: z.array(Message).optional(),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadList = z.object({
  threads: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});
