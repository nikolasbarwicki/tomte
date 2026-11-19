import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { z } from "zod";

import { attachmentsOf, formatBytes } from "./attachments.ts";
import { cut, htmlToText, oneLine, wrapMail } from "./mail-text.ts";
import { gmailTool, ToolInputError } from "./tool.ts";
import { Message } from "./wire.ts";

/** A text attachment longer than this many characters is cut with a marker. */
const TEXT_LIMIT = 20_000;
/** Where attachments are saved, below the bot's files folder. */
const SAVE_DIR = "gmail-attachments";

const AttachmentBody = z.object({ data: z.string().optional() });

const isText = (mime: string) =>
  /^text\//i.test(mime) ||
  /^application\/(json|xml|x-ndjson|yaml|x-yaml)\b|[+](json|xml)$/i.test(mime);

/** A name that is safe as one file name: letters, digits and `._- ` only, no leading dot, at most 100 characters. */
function fileName(name: string): string {
  const clean = oneLine(name)
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .slice(-100)
    .trim();
  return clean || "attachment";
}

/** Writes `bytes` into `dir`/gmail-attachments under a free name and returns the path. Nothing is overwritten, and a symlinked folder is refused. */
function saveFile(dir: string, name: string, bytes: Buffer): string {
  const into = join(dir, SAVE_DIR);
  mkdirSync(into, { recursive: true });
  const real = realpathSync(into);
  if (!real.startsWith(realpathSync(dir) + sep))
    throw new ToolInputError("the files folder cannot be written to safely");
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const path = join(real, i === 1 ? name : `${stem} ${i}${ext}`);
    try {
      writeFileSync(path, bytes, { flag: "wx" });
      return path;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
}

const getAttachment = gmailTool({
  name: "get_attachment",
  description:
    "Get one attachment of a message (message id and part_id as get_thread shows them). A text attachment is returned as text, cut when long. Any other file is saved in your files folder and its path is returned.",
  verb: "read",
  input: {
    message_id: z.string().describe("The message id from get_thread"),
    part_id: z.string().describe("The part_id of the attachment, from get_thread"),
  },
  async run(api, { message_id, part_id }, ctx) {
    const message = Message.parse(
      await api.call(
        "messages.get",
        { path: `messages/${encodeURIComponent(message_id)}`, query: { format: "full" } },
        message_id,
      ),
    );
    const info =
      message.payload && attachmentsOf(message.payload).find((a) => a.partId === part_id);
    if (!info)
      throw new ToolInputError(
        `message ${message_id} has no attachment with part_id ${part_id}; get_thread lists them`,
      );
    const attachmentId = info.part.body?.attachmentId;
    const data =
      attachmentId !== undefined
        ? AttachmentBody.parse(
            await api.call(
              "attachments.get",
              {
                path: `messages/${encodeURIComponent(message_id)}/attachments/${encodeURIComponent(attachmentId)}`,
              },
              message_id,
            ),
          ).data
        : info.part.body?.data;
    const bytes = Buffer.from(data ?? "", "base64url");
    const label = `${cut(oneLine(info.name), 200)} (${oneLine(info.mimeType)}, ${formatBytes(bytes.length)})`;
    if (isText(info.mimeType)) {
      const text = bytes.toString("utf8");
      return wrapMail(
        `Attachment ${label}\n\n${cut(/^text\/html/i.test(info.mimeType) ? htmlToText(text) : text, TEXT_LIMIT)}`,
      );
    }
    if (!ctx.filesDir)
      throw new ToolInputError("there is no files folder to save the attachment in");
    const path = saveFile(ctx.filesDir, fileName(info.name), bytes);
    return `Saved the attachment (${info.mimeType.replace(/[^\w./+-]/g, "")}, ${formatBytes(bytes.length)}) to ${path}`;
  },
});

export const ATTACHMENT_TOOLS = [getAttachment];
