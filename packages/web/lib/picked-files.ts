/** A file the user picked or dropped, with its path as picked: `report.pdf`, or `notes/june.md` inside a folder. */
export type PickedFile = { path: string; file: File };

/** What one pick or drop holds for one name: a single file, or a folder with every file under it (paths start with the folder's name). */
export type PickedGroup = { name: string; folder: boolean; files: PickedFile[] };

/** What a file input picked: each file on its own, or with `webkitdirectory` one folder of files. */
export function groupsFromInput(list: FileList, folder: boolean): PickedGroup[] {
  const files = [...list];
  if (!folder)
    return files.map((file) => ({
      name: file.name,
      folder: false,
      files: [{ path: file.name, file }],
    }));
  const name = files[0]?.webkitRelativePath.split("/")[0];
  if (name === undefined) return [];
  return [
    { name, folder: true, files: files.map((file) => ({ path: file.webkitRelativePath, file })) },
  ];
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
export async function groupsFromTransfer(dt: DataTransfer): Promise<PickedGroup[]> {
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
  return [
    ...files.map((file) => ({
      name: file.name,
      folder: false,
      files: [{ path: file.name, file }],
    })),
    ...(await Promise.all(
      dirs.map(async (dir) => ({ name: dir.name, folder: true, files: await filesUnder(dir) })),
    )),
  ];
}
