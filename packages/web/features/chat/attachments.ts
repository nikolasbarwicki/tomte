import { MAX_ATTACHMENT_BYTES } from "@tomte/contract/api";
import { toast } from "sonner";

import { fileSize } from "@/lib/format.ts";

import type { PickedFile } from "./api.ts";

/** A file or folder waiting in the composer; it is saved on the host when the message is sent. */
export type DraftAttachment = { key: string; name: string; folder: boolean; files: PickedFile[] };

/** One draft per group of picked files that share a first path segment, refusing (with a toast) an empty folder or one too large to send. */
function draftsOf(
  groups: { name: string; folder: boolean; files: PickedFile[] }[],
): DraftAttachment[] {
  return groups.flatMap((g) => {
    if (g.files.length === 0) {
      toast.error(`${g.name} is empty`);
      return [];
    }
    const size = g.files.reduce((n, f) => n + f.file.size, 0);
    if (size > MAX_ATTACHMENT_BYTES) {
      toast.error(
        `${g.name} is ${fileSize(size)}; an attachment holds at most ${fileSize(MAX_ATTACHMENT_BYTES)}`,
      );
      return [];
    }
    return [{ key: crypto.randomUUID(), ...g }];
  });
}

/** What a file input picked: each file on its own, or with `webkitdirectory` one folder of files. */
export function draftsFromInput(list: FileList, folder: boolean): DraftAttachment[] {
  const files = [...list];
  if (!folder)
    return draftsOf(
      files.map((file) => ({ name: file.name, folder: false, files: [{ path: file.name, file }] })),
    );
  const name = files[0]?.webkitRelativePath.split("/")[0];
  if (name === undefined) return [];
  return draftsOf([
    { name, folder: true, files: files.map((file) => ({ path: file.webkitRelativePath, file })) },
  ]);
}

const isDir = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;
const isFile = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;

/** Every file under a dropped folder, with paths that start with the folder's name. */
async function filesUnder(dir: FileSystemDirectoryEntry): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (d: FileSystemDirectoryEntry) => {
    const reader = d.createReader();
    // `readEntries` hands out a folder's entries in batches until it returns none.
    for (;;) {
      const batch = Promise.withResolvers<FileSystemEntry[]>();
      reader.readEntries(batch.resolve, batch.reject);
      const entries = await batch.promise;
      if (entries.length === 0) return;
      for (const e of entries) {
        if (isDir(e)) await walk(e);
        else if (isFile(e)) {
          const file = Promise.withResolvers<File>();
          e.file(file.resolve, file.reject);
          out.push({ path: e.fullPath.replace(/^\//, ""), file: await file.promise });
        }
      }
    }
  };
  await walk(dir);
  return out;
}

/** What was dropped or pasted: files, and with drag and drop, folders with everything in them. */
export async function draftsFromTransfer(dt: DataTransfer): Promise<DraftAttachment[]> {
  // Entries must be taken while the event is being handled; the list is emptied once it returns.
  const dirs: FileSystemDirectoryEntry[] = [];
  const files: File[] = [];
  for (const item of dt.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    if (entry && isDir(entry)) dirs.push(entry);
    else if (file) files.push(file);
  }
  return draftsOf([
    ...files.map((file) => ({
      name: file.name,
      folder: false,
      files: [{ path: file.name, file }],
    })),
    ...(await Promise.all(
      dirs.map(async (dir) => ({ name: dir.name, folder: true, files: await filesUnder(dir) })),
    )),
  ]);
}
