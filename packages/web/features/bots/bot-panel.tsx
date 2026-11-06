import { useTransition, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { Streamdown } from "streamdown";
import { EllipsisIcon, FileIcon, FolderOpenIcon, TrashIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BotFile, BotSummary } from "@claudebot/contract/events";
import { useFiles, useMemory, useRoutines } from "@/host/hooks.ts";
import { deleteFile, revealFile } from "./api.ts";
import { confirmAction } from "@/components/confirm.tsx";
import { dateTime, fileSize } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

export const PANEL_TABS = ["memory", "files", "routines", "browser"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
const isPanelTab = (v: unknown): v is PanelTab => PANEL_TABS.some((t) => t === v);

const botRoute = getRouteApi("/bots/$botId");

export function BotPanel({ bot, routines, browser, onClose }: { bot: BotSummary; routines: ReactNode; browser: ReactNode; onClose: () => void }) {
  const navigate = botRoute.useNavigate();
  const tab = botRoute.useSearch({ select: (s) => s.panel ?? "memory" });
  const files = useFiles();
  const routineList = useRoutines();
  const botRoutines = routineList?.botId === bot.id ? routineList.routines : undefined;
  return (
    <Tabs value={tab} onValueChange={(v) => isPanelTab(v) && void navigate({ search: (prev) => ({ ...prev, panel: v }), replace: true })} className="h-full min-h-0 gap-0">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <TabsList className="min-w-0 flex-1">
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="files">
            Files <Count n={files.files.length} />
          </TabsTrigger>
          <TabsTrigger value="routines">
            Routines <Count n={botRoutines?.length ?? 0} />
          </TabsTrigger>
          <TabsTrigger value="browser">
            Browser
            {bot.browser.enabled && <span className="size-1.5 rounded-full bg-emerald-500" aria-label="on" />}
          </TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
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
  return n > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{n}</span> : null;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function MemoryText({ text, empty }: { text: string; empty: string }) {
  if (!text.trim()) return <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="rounded-lg bg-muted/50 p-3 text-sm break-words">
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
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Everything {bot.name} produced.</p>
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
      </div>
      {files.files.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No files yet</EmptyTitle>
            <EmptyDescription className="text-xs">Reports, exports and anything else the bot saves show up here.</EmptyDescription>
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
  const reveal = () =>
    startTransition(async () => {
      await revealFile(f.path);
    });
  const remove = async () => {
    if (await confirmAction({ title: `Delete ${f.path}?`, description: "This cannot be undone.", action: "Delete", destructive: true })) {
      startTransition(async () => {
        await deleteFile(f.path);
      });
    }
  };
  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60">
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <button type="button" className="grid min-w-0 flex-1 text-left" title={`Show ${f.path} in Finder`} disabled={pending} onClick={reveal}>
        <span className="truncate text-sm">{f.path}</span>
        <span className="text-xs text-muted-foreground">
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
              className={cn("opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100", pending && "opacity-100")}
            />
          }
        >
          {pending ? <Spinner /> : <EllipsisIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={reveal}>
            <FolderOpenIcon /> Show in Finder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={remove}>
            <TrashIcon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
