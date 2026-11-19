import { FolderSimpleIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { use, useRef, useState, useTransition, type ComponentProps } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ShownBot, useOpenBotId } from "@/host/hooks.ts";
import { uploadAll } from "@/host/upload.ts";
import { groupsFromInput, groupsFromTransfer, type PickedGroup } from "@/lib/picked-files.ts";

/**
 * Uploads what was picked or dropped into the open bot's files folder, each file to the path it was picked with (a folder
 * keeps its tree), and tells the user what happened: a name that was taken is renamed, and the toast says from what.
 */
async function uploadGroups(groups: PickedGroup[]): Promise<void> {
  for (const g of groups) if (g.files.length === 0) toast.error(`${g.name} is empty`);
  const files = groups.flatMap((g) => g.files);
  if (files.length === 0) return;
  const results = await uploadAll(files);
  const saved = results.filter((r) => r !== undefined);
  const renamed = saved.filter((r) => r.renamedFrom !== undefined);
  if (saved.length < files.length && files.length > 1)
    toast.error(`${files.length - saved.length} of ${files.length} files were not uploaded`);
  if (saved.length === 0) return;
  toast.success(
    saved.length === 1 ? `Uploaded ${saved[0]!.path}` : `Uploaded ${saved.length} files`,
  );
  if (renamed.length === 1)
    toast.info(`${renamed[0]!.renamedFrom} was taken; saved as ${renamed[0]!.path}`);
  else if (renamed.length > 1)
    toast.info(`${renamed.length} names were taken; those files were saved under new names`);
}

/**
 * Drop and pick handling for the Files section: spread `dropHandlers` on the element that takes drops (`dragging` is true
 * while a file is over it), render `buttons` where the pick buttons go (it includes the hidden inputs). The host saves into
 * the chat it streams, so nothing is accepted while another bot's chat is still being opened.
 */
export function useFilesUpload() {
  const ready = use(ShownBot) === useOpenBotId();
  const [dragging, setDragging] = useState(false);
  const [uploading, startUploading] = useTransition();
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const run = (groups: PickedGroup[]) =>
    startUploading(async () => {
      await uploadGroups(groups);
    });

  const dropHandlers: Pick<ComponentProps<"div">, "onDragOver" | "onDragLeave" | "onDrop"> = {
    onDragOver: (e) => {
      if (!ready || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (e) => {
      const to = e.relatedTarget;
      if (!(to instanceof Node && e.currentTarget.contains(to))) setDragging(false);
    },
    onDrop: (e) => {
      if (!ready || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(false);
      void groupsFromTransfer(e.dataTransfer).then(run);
    },
  };

  const buttons = (
    <div className="flex gap-1.5">
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const { files } = e.currentTarget;
          if (files) run(groupsFromInput(files, false));
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          const { files } = e.currentTarget;
          if (files) run(groupsFromInput(files, true));
          e.currentTarget.value = "";
        }}
      />
      <Button
        variant="outline"
        size="xs"
        disabled={!ready || uploading}
        onClick={() => filePicker.current?.click()}
      >
        {uploading ? <Spinner /> : <UploadSimpleIcon />} Upload files
      </Button>
      <Button
        variant="outline"
        size="xs"
        disabled={!ready || uploading}
        onClick={() => folderPicker.current?.click()}
      >
        <FolderSimpleIcon /> Upload folder
      </Button>
    </div>
  );

  return { dropHandlers, dragging, buttons };
}
