import type { BotFile, BotSummary } from "@claudebot/contract/events";
import { getRouteApi } from "@tanstack/react-router";
import {
  DownloadIcon,
  EllipsisIcon,
  FileIcon,
  FolderOpenIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useTransition, type ReactNode } from "react";
import { Streamdown } from "streamdown";

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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFiles, useMemory, usePublicHostInfo, useRoutines, useWork } from "@/host/hooks.ts";
import { dateTime, fileSize } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

import { deleteFile, downloadUrl, revealFile } from "./api.ts";

export const PANEL_TABS = ["work", "memory", "files", "routines", "browser"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
const isPanelTab = (v: unknown): v is PanelTab => PANEL_TABS.some((t) => t === v);

const botRoute = getRouteApi("/bots/$botId");

/** Whether the host can reveal a folder in a file manager; false until the host says so. */
const useCanReveal = () => usePublicHostInfo()?.capabilities.reveal === true;

export function BotPanel({
  bot,
  work,
  routines,
  browser,
  onClose,
}: {
  bot: BotSummary;
  work: ReactNode;
  routines: ReactNode;
  browser: ReactNode;
  onClose: () => void;
}) {
  const navigate = botRoute.useNavigate();
  const explicitTab = botRoute.useSearch({ select: (s) => s.panel });
  const botWork = useWork();
  // Work leads once the bot has sources; before that it comes last, so the events URL stays one tab away.
  const hasSources = botWork?.botId === bot.id && botWork.sources.length > 0;
  const tab = explicitTab ?? (hasSources ? "work" : "memory");
  const workTrigger = (
    <TabsTrigger value="work">
      Work
      {bot.needsYou > 0 && (
        <span
          className="rounded-full bg-amber-500/15 px-1.5 text-xs font-medium text-amber-700 tabular-nums dark:text-amber-400"
          aria-label={`${bot.needsYou} need you`}
          data-needs-you={bot.needsYou}
        >
          {bot.needsYou}
        </span>
      )}
    </TabsTrigger>
  );
  const files = useFiles();
  const routineList = useRoutines();
  const botRoutines = routineList?.botId === bot.id ? routineList.routines : undefined;
  return (
    <Tabs
      value={tab}
      onValueChange={(v) =>
        isPanelTab(v) && void navigate({ search: (prev) => ({ ...prev, panel: v }), replace: true })
      }
      className="h-full min-h-0 gap-0"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <TabsList className="min-w-0 flex-1">
          {hasSources && workTrigger}
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="files">
            Files <Count n={files.files.length} />
          </TabsTrigger>
          <TabsTrigger value="routines">
            Routines <Count n={botRoutines?.length ?? 0} />
          </TabsTrigger>
          <TabsTrigger value="browser">
            Browser
            {bot.browser.enabled && (
              <span className="size-1.5 rounded-full bg-emerald-500" aria-label="on" />
            )}
          </TabsTrigger>
          {!hasSources && workTrigger}
        </TabsList>
        <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <TabsContent value="work" className="min-h-0 overflow-y-auto p-4">
        {work}
      </TabsContent>
      <TabsContent value="memory" className="min-h-0 overflow-y-auto p-4">
        <Memory bot={bot} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0 overflow-y-auto p-4">
        <Files bot={bot} />
      </TabsContent>
      <TabsContent value="routines" className="min-h-0 overflow-y-auto p-4">
        {botRoutines ? (
          routines
        ) : (
          <div className="flex justify-center p-6">
            <Spinner className="text-muted-foreground" />
          </div>
        )}
      </TabsContent>
      <TabsContent value="browser" className="min-h-0 overflow-y-auto p-4">
        {browser}
      </TabsContent>
    </Tabs>
  );
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="text-muted-foreground text-xs tabular-nums">{n}</span> : null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {children}
    </section>
  );
}

function MemoryText({ text, empty }: { text: string; empty: string }) {
  if (!text.trim())
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">{empty}</p>
    );
  return (
    <div className="bg-muted/50 rounded-lg p-3 text-sm break-words">
      <Streamdown linkSafety={{ enabled: false }}>{text}</Streamdown>
    </div>
  );
}

function Memory({ bot }: { bot: BotSummary }) {
  const memory = useMemory();
  return (
    <div className="grid gap-6">
      <Section title="About you" description="What every bot knows about you.">
        <MemoryText text={memory.user} empty="Nothing remembered yet." />
      </Section>
      <Section title={`How ${bot.name} works`} description="Directions only this bot follows.">
        <MemoryText text={memory.bot} empty="No directions yet." />
      </Section>
    </div>
  );
}

function Files({ bot }: { bot: BotSummary }) {
  const files = useFiles();
  const [opening, startOpening] = useTransition();
  const canReveal = useCanReveal();
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">Everything {bot.name} produced.</p>
        {canReveal && (
          <Button
            variant="outline"
            size="sm"
            title={files.dir}
            disabled={opening}
            onClick={() =>
              startOpening(async () => {
                await revealFile();
              })
            }
          >
            {opening ? <Spinner /> : <FolderOpenIcon />} Open folder
          </Button>
        )}
      </div>
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
      ) : (
        <ul className="-mx-2 grid">
          {files.files.map((f) => (
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
          {pending ? <Spinner /> : <EllipsisIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem render={<a href={downloadUrl(f.path)} download />}>
            <DownloadIcon /> Download
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
