import { Streamdown } from "streamdown";
import { EllipsisIcon, FileIcon, FolderOpenIcon, GlobeIcon, TrashIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BotSummary, FilesEvent, MemoryScope, Routine } from "@claudebot/contract/events";
import { act } from "./api.ts";
import { BrowserPanel } from "./browser-panel.tsx";
import { confirmAction } from "./confirm.tsx";
import { dateTime, fileSize } from "./format.ts";
import { Routines } from "./routines.tsx";

const PANEL_TABS = ["memory", "files", "routines", "browser"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
const isPanelTab = (v: unknown): v is PanelTab => PANEL_TABS.some((t) => t === v);

export function BotPanel({
  bot,
  tab,
  onTab,
  memory,
  files,
  routines,
  browserUnavailable,
  onClose,
}: {
  bot: BotSummary;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines: Routine[] | undefined;
  browserUnavailable: string | undefined;
  onClose: () => void;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => isPanelTab(v) && onTab(v)} className="h-full min-h-0 gap-0">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <TabsList className="min-w-0 flex-1">
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="files">
            Files <Count n={files.files.length} />
          </TabsTrigger>
          <TabsTrigger value="routines">
            Routines <Count n={routines?.length ?? 0} />
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
        <Memory bot={bot} memory={memory} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0 overflow-y-auto p-4">
        <Files bot={bot} files={files} />
      </TabsContent>
      <TabsContent value="routines" className="min-h-0 overflow-y-auto p-4">
        {routines ? (
          <Routines botId={bot.id} routines={routines} />
        ) : (
          <div className="flex justify-center p-6">
            <Spinner className="text-muted-foreground" />
          </div>
        )}
      </TabsContent>
      <TabsContent value="browser" className="min-h-0 overflow-y-auto p-4">
        <Browser bot={bot} unavailable={browserUnavailable} />
      </TabsContent>
    </Tabs>
  );
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{n}</span> : null;
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
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

function Memory({ bot, memory }: { bot: BotSummary; memory: Record<MemoryScope, string> }) {
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

function Files({ bot, files }: { bot: BotSummary; files: FilesEvent }) {
  const remove = async (path: string) => {
    if (await confirmAction({ title: `Delete ${path}?`, description: "This cannot be undone.", action: "Delete", destructive: true })) {
      await act("/api/files/delete", { path });
    }
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Everything {bot.name} produced.</p>
        <Button variant="outline" size="sm" title={files.dir} onClick={() => act("/api/files/reveal", {})}>
          <FolderOpenIcon /> Open folder
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
            <li key={f.path} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <button type="button" className="grid min-w-0 flex-1 text-left" title={`Show ${f.path} in Finder`} onClick={() => act("/api/files/reveal", { path: f.path })}>
                <span className="truncate text-sm">{f.path}</span>
                <span className="text-xs text-muted-foreground">
                  {fileSize(f.size)} · {dateTime(f.mtime)}
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${f.path}`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" />}>
                  <EllipsisIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => act("/api/files/reveal", { path: f.path })}>
                    <FolderOpenIcon /> Show in Finder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => remove(f.path)}>
                    <TrashIcon /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Browser({ bot, unavailable }: { bot: BotSummary; unavailable: string | undefined }) {
  return (
    <div className="grid gap-4">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="browser-enabled">
            <GlobeIcon className="size-4" /> Web browser
          </FieldLabel>
          <FieldDescription className="text-xs">Gives {bot.name} its own browser. It starts on the bot's first browser call, not when you switch it on.</FieldDescription>
        </FieldContent>
        <Switch
          id="browser-enabled"
          checked={bot.browser.enabled}
          disabled={!!unavailable && !bot.browser.enabled}
          onCheckedChange={(enabled) => act("/api/bots/browser", { botId: bot.id, enabled })}
        />
      </Field>
      {unavailable && (
        <Alert>
          <AlertDescription>Unavailable: {unavailable}</AlertDescription>
        </Alert>
      )}
      {bot.browser.enabled && <BrowserPanel key={bot.id} botId={bot.id} botName={bot.name} headed={bot.browser.headed} />}
    </div>
  );
}
