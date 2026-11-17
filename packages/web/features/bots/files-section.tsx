import {
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { BotFile } from "@tomte/contract/events";
import { useState, useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { downloadUrl } from "@/host/api.ts";
import { useFiles, usePublicHostInfo } from "@/host/hooks.ts";
import { copyText } from "@/lib/clipboard.ts";
import { dateTime, fileSize } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

import { deleteFile, revealFile } from "./api.ts";

/** Whether the host can reveal a folder in a file manager; false until the host says so. */
const useCanReveal = () => usePublicHostInfo()?.capabilities.reveal === true;

/** The Files section: the folder the bot saves into, a search box over its files, and each file's actions. */
export function Files({ botName }: { botName: string }) {
  const files = useFiles();
  const [query, setQuery] = useState("");
  const [opening, startOpening] = useTransition();
  const canReveal = useCanReveal();
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? files.files.filter((f) => f.path.toLowerCase().includes(needle))
    : files.files;
  return (
    <div className="grid grid-cols-1 gap-3">
      <p className="text-muted-foreground text-xs">Everything {botName} produced.</p>
      {files.dir && (
        <div className="bg-muted/60 flex items-center gap-1 rounded-lg py-1 pr-1 pl-2.5">
          <code className="min-w-0 flex-1 truncate text-xs" title={files.dir}>
            {files.dir}
          </code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy folder path"
            title="Copy folder path"
            onClick={() => void copyText(files.dir, "Folder path")}
          >
            <CopyIcon />
          </Button>
          {canReveal && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open folder"
              title="Open folder"
              disabled={opening}
              onClick={() =>
                startOpening(async () => {
                  await revealFile();
                })
              }
            >
              {opening ? <Spinner /> : <FolderOpenIcon />}
            </Button>
          )}
        </div>
      )}
      {files.files.length > 0 && (
        <InputGroup>
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search files"
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
      )}
      {files.files.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No files yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Reports, exports and anything else the bot saves show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground px-1 text-sm">No file matches “{query.trim()}”.</p>
      ) : (
        <ul className="-mx-2 grid">
          {shown.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({ file: f }: { file: BotFile }) {
  const [pending, startTransition] = useTransition();
  const canReveal = useCanReveal();
  const reveal = () =>
    startTransition(async () => {
      await revealFile(f.path);
    });
  const remove = async () => {
    if (
      await confirmAction({
        title: `Delete ${f.path}?`,
        description: "This cannot be undone.",
        action: "Delete",
        destructive: true,
      })
    ) {
      startTransition(async () => {
        await deleteFile(f.path);
      });
    }
  };
  return (
    <li className="group hover:bg-muted/60 flex items-center gap-3 rounded-lg px-2 py-1.5">
      <FileIcon className="text-muted-foreground size-4 shrink-0" />
      <button
        type="button"
        className="grid min-w-0 flex-1 text-left"
        title={canReveal ? `Show ${f.path} in Finder` : undefined}
        disabled={pending || !canReveal}
        onClick={reveal}
      >
        <span className="truncate text-sm">{f.path}</span>
        <span className="text-muted-foreground text-xs">
          {fileSize(f.size)} · {dateTime(f.mtime)}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              aria-label={`Actions for ${f.path}`}
              className={cn(
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
                pending && "opacity-100",
              )}
            />
          }
        >
          {pending ? <Spinner /> : <DotsThreeIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem render={<a href={downloadUrl(f.path)} download />}>
            <DownloadSimpleIcon /> Download
          </DropdownMenuItem>
          {canReveal && (
            <DropdownMenuItem onClick={reveal}>
              <FolderOpenIcon /> Show in Finder
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
            <TrashIcon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
