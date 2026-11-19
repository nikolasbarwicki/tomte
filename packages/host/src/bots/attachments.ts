import { existsSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Attachment } from "@tomte/contract/events";

import { resolveInside } from "./files.ts";

/** Whether `a` is still in the files folder `dir` as what it claims to be. */
export function attachmentExists(dir: string, a: Attachment): boolean {
  const abs = resolveInside(dir, a.path);
  if (!abs || !existsSync(abs)) return false;
  const s = lstatSync(abs);
  return a.folder ? s.isDirectory() : s.isFile();
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unattr = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The tags the host appends to a user message for its attachments: what each is and its absolute path, for the bot. */
export const attachmentTags = (dir: string, attachments: Attachment[]): string[] =>
  attachments.map(
    (a) => `<attachment kind="${a.folder ? "folder" : "file"}" path="${attr(join(dir, a.path))}"/>`,
  );

const ATTACHMENT_TAG = /<attachment kind="(file|folder)" path="([^"]*)"\/>/g;

/** Splits a delivered user message back into the rest of it and its attachments, relative to the files folder `dir`; a path outside it is dropped. */
export function parseAttachments(
  dir: string,
  text: string,
): { text: string; attachments: Attachment[] } {
  const attachments = [...text.matchAll(ATTACHMENT_TAG)].flatMap(([, kind, path = ""]) => {
    const rel = relative(dir, unattr(path));
    return resolveInside(dir, rel)
      ? [{ path: rel.split(sep).join("/"), folder: kind === "folder" }]
      : [];
  });
  return { text: text.replace(ATTACHMENT_TAG, "").trim(), attachments };
}
