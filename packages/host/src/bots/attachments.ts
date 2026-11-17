import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

import type { Attachment } from "@tomte/contract/events";

import { resolveInside } from "./files.ts";

/** The subfolder of a bot's files folder that holds what the user attaches. */
export const ATTACHMENTS_DIR = "attachments";

/** A file the user attached: `path` as picked (`report.pdf`, `notes/june.md`), `/`-separated. */
export type AttachedFile = { path: string; bytes: Uint8Array };

/** An attachment that cannot be saved; the route answers it with 400. */
export class BadAttachment extends Error {}

const segmentsOf = (path: string) => {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0")))
    throw new BadAttachment(`not a relative path: ${path}`);
  return parts;
};

/** `name`, or `name 2`, `name 3`… (before the extension of a file) for the first that `taken` refuses. */
function freeName(name: string, folder: boolean, taken: (n: string) => boolean): string {
  const ext = folder ? "" : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = name;
  for (let i = 2; taken(n); i++) n = `${stem} ${i}${ext}`;
  return n;
}

/**
 * Saves one attachment (a file, or a folder's files) under `attachments/` of the files folder `dir`, renamed `name 2` when
 * the name is taken, and returns where it went. Every path must start with the same first segment, the attachment's
 * name; a file is a single path of one segment. Nothing is written outside `dir`, through a symlink either, and no file is
 * overwritten.
 */
export function saveAttachment(dir: string, files: AttachedFile[]): Attachment {
  const split = files.map((f) => ({ parts: segmentsOf(f.path), bytes: f.bytes }));
  const name = split[0]?.parts[0];
  if (name === undefined) throw new BadAttachment("nothing to attach");
  const folder = split.some((f) => f.parts.length > 1);
  if (split.some((f) => f.parts[0] !== name || (folder && f.parts.length === 1)))
    throw new BadAttachment("an attachment is one file or one folder");
  if (!folder && split.length > 1)
    throw new BadAttachment("an attachment is one file or one folder");

  const into = join(dir, ATTACHMENTS_DIR);
  mkdirSync(into, { recursive: true });
  // A bot may have swapped the folder for a symlink; everything below it is created here, fresh, so this one check holds for it all.
  if (!resolveInside(realpathSync(dir), realpathSync(into)))
    throw new BadAttachment(`${ATTACHMENTS_DIR} is not inside the files folder`);
  const top = freeName(
    name,
    folder,
    (n) => lstatSync(join(into, n), { throwIfNoEntry: false }) !== undefined,
  );
  for (const f of split) {
    const target = join(into, top, ...f.parts.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes, { flag: "wx" });
  }
  return { path: `${ATTACHMENTS_DIR}/${top}`, folder };
}

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
