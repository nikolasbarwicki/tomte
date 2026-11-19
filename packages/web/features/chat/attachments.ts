import { toast } from "sonner";

import { tooLargeFor } from "@/host/upload.ts";
import {
  groupsFromInput,
  groupsFromTransfer,
  type PickedFile,
  type PickedGroup,
} from "@/lib/picked-files.ts";

/** A file or folder waiting in the composer; it is uploaded to the host when the message is sent. */
export type DraftAttachment = { key: string; name: string; folder: boolean; files: PickedFile[] };

/** One draft per picked group, refusing (with a toast) an empty folder or one holding a file the host would refuse as too large. */
function draftsOf(groups: PickedGroup[]): DraftAttachment[] {
  return groups.flatMap((g) => {
    if (g.files.length === 0) {
      toast.error(`${g.name} is empty`);
      return [];
    }
    const tooLarge = g.files.map((f) => tooLargeFor(f.file, f.path)).find((m) => m !== undefined);
    if (tooLarge) {
      toast.error(tooLarge);
      return [];
    }
    return [{ key: crypto.randomUUID(), ...g }];
  });
}

/** What a file input picked: each file on its own, or with `webkitdirectory` one folder of files. */
export const draftsFromInput = (list: FileList, folder: boolean) =>
  draftsOf(groupsFromInput(list, folder));

/** What was dropped or pasted: files, and with drag and drop, folders with everything in them. */
export async function draftsFromTransfer(dt: DataTransfer): Promise<DraftAttachment[]> {
  return draftsOf(await groupsFromTransfer(dt));
}
