import type { MessagePart } from "./wire.ts";

/** A file attached to a message, as Gmail lists it. */
export interface AttachmentInfo {
  partId: string;
  name: string;
  mimeType: string;
  /** In bytes. */
  size: number;
  part: MessagePart;
}

/** The attachments in a message's parts, in order: named parts whose content Gmail serves by attachment id or inline. */
export function attachmentsOf(part: MessagePart): AttachmentInfo[] {
  const own =
    part.filename && part.partId !== undefined && (part.body?.attachmentId || part.body?.data)
      ? [
          {
            partId: part.partId,
            name: part.filename,
            mimeType: part.mimeType ?? "application/octet-stream",
            size: part.body.size ?? 0,
            part,
          },
        ]
      : [];
  return [...own, ...(part.parts ?? []).flatMap(attachmentsOf)];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
