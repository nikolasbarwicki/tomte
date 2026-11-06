import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, AtSignIcon, ChevronDownIcon, MessageSquarePlusIcon, PanelRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { BotSummary, ContextEvent, FilesEvent, MemoryScope, Routine } from "./events.ts";
import { act } from "./api.ts";
import { BotPanel, type PanelTab } from "./bot-panel.tsx";
import { confirmAction } from "./confirm.tsx";
import { kTokens } from "./format.ts";
import { AppBar } from "./page.tsx";
import { Transcript, type Item } from "./transcript.tsx";

const PANEL_KEY = "claudebot:panel";

/** One bot: its conversation, and beside it the panel with what the bot knows, made and runs. */
export function ChatView({
  bot,
  bots,
  items,
  busy,
  context,
  memory,
  files,
  routines,
  browserUnavailable,
  draft,
  onDraftTaken,
}: {
  bot: BotSummary;
  bots: BotSummary[];
  items: Item[];
  busy: boolean;
  context: ContextEvent | undefined;
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines: Routine[] | undefined;
  browserUnavailable: string | undefined;
  /** Text to start the composer with, e.g. an integration's example prompt. */
  draft: string | undefined;
  onDraftTaken: () => void;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [pinned, setPinned] = useState(() => localStorage.getItem(PANEL_KEY) !== "closed");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("memory");
  const panelOpen = wide ? pinned : sheetOpen;
  const setPanelOpen = (open: boolean) => {
    if (!wide) return setSheetOpen(open);
    setPinned(open);
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  };
  const showBrowser = () => {
    setTab("browser");
    setPanelOpen(true);
  };

  // A takeover request needs the live view, so bring it up as soon as one arrives.
  const takeoverId = items.flatMap((i) => (i.kind === "wait" && i.waitKind === "takeover" && i.resolved === undefined ? [i.id] : [])).at(-1);
  useEffect(() => {
    if (takeoverId) showBrowser();
  }, [takeoverId]);

  const panel = (
    <BotPanel
      bot={bot}
      tab={tab}
      onTab={setTab}
      memory={memory}
      files={files}
      routines={routines}
      browserUnavailable={browserUnavailable}
      onClose={() => setPanelOpen(false)}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <AppBar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{bot.name}</h1>
            {bot.purpose && <p className="truncate text-xs text-muted-foreground">{bot.purpose}</p>}
          </div>
          <ContextMeter context={context} />
          <ModelMenu />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New session"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirmAction({
                      title: `Start a new session for ${bot.name}?`,
                      description: "The bot forgets this conversation. Memory, files and routines are kept.",
                      action: "New session",
                    });
                    if (ok) await act("/api/session/new", {});
                  }}
                />
              }
            >
              <MessageSquarePlusIcon />
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Toggle bot panel" aria-pressed={panelOpen} className={cn(panelOpen && "bg-muted")} onClick={() => setPanelOpen(!panelOpen)} />
              }
            >
              <PanelRightIcon />
            </TooltipTrigger>
            <TooltipContent>Memory, files, routines and browser</TooltipContent>
          </Tooltip>
        </AppBar>
        <Transcript bot={bot} items={items} busy={busy} onShowBrowser={showBrowser} />
        <Composer bot={bot} bots={bots} busy={busy} draft={draft} onDraftTaken={onDraftTaken} />
      </div>
      {wide ? (
        panelOpen && <aside className="flex w-[400px] shrink-0 flex-col border-l xl:w-[440px]">{panel}</aside>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <SheetTitle className="sr-only">{bot.name}</SheetTitle>
            <SheetDescription className="sr-only">Memory, files, routines and browser</SheetDescription>
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function ContextMeter({ context }: { context: ContextEvent | undefined }) {
  const pct = context?.percentage ?? 0;
  const high = pct >= 80;
  const r = 6;
  const circumference = 2 * Math.PI * r;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs tabular-nums", high ? "text-destructive" : "text-muted-foreground")} />}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct / 100)}
            className={high ? "stroke-destructive" : "stroke-primary"}
          />
        </svg>
        <span className="hidden sm:inline">{context ? `${pct}%` : "–"}</span>
      </TooltipTrigger>
      <TooltipContent>
        {context
          ? `Context ${pct}% full · ${kTokens(context.tokens)} of ${kTokens(context.max)} tokens${high ? ". Consider a new session." : ""}`
          : "Context usage appears after the next reply"}
      </TooltipContent>
    </Tooltip>
  );
}

const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "max"];

/** Switches the open session's model and effort. The host does not report the current values, so only choices made here show. */
function ModelMenu() {
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="text-muted-foreground" />}>
        <span className="capitalize">{model ?? "Model"}</span>
        {effort && <span className="hidden sm:inline">· {effort}</span>}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={model ?? ""}
            onValueChange={async (v: string) => {
              if (await act("/api/model", { model: v })) setModel(v);
            }}
          >
            {MODELS.map((m) => (
              <DropdownMenuRadioItem key={m} value={m} className="capitalize">
                {m}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Effort</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={effort ?? ""}
            onValueChange={async (v: string) => {
              if (await act("/api/effort", { effort: v })) setEffort(v);
            }}
          >
            {EFFORTS.map((e) => (
              <DropdownMenuRadioItem key={e} value={e} className="capitalize">
                {e}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Composer({ bot, bots, busy, draft, onDraftTaken }: { bot: BotSummary; bots: BotSummary[]; busy: boolean; draft: string | undefined; onDraftTaken: () => void }) {
  const [input, setInput] = useState(draft ?? "");
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  const [highlight, setHighlight] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // The draft is now this composer's own text; leave the caret after it so the user can edit or send.
  useEffect(() => {
    if (draft === undefined) return;
    textarea.current?.setSelectionRange(draft.length, draft.length);
    onDraftTaken();
  }, []);

  const mentionQuery = input.match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const candidates =
    mentionQuery === undefined
      ? []
      : bots.filter((b) => b.id !== bot.id && !mentions.some((m) => m.id === b.id) && b.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  const active = Math.min(highlight, candidates.length - 1);

  const pick = (b: BotSummary) => {
    setInput(input.replace(/@[^\s@]*$/, ""));
    setMentions([...mentions, { id: b.id, name: b.name }]);
    setHighlight(0);
    textarea.current?.focus();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const sent = { text, mentions };
    setInput("");
    setMentions([]);
    if (!(await act("/api/send", { text: sent.text, mentions: sent.mentions.map((m) => m.id) }))) {
      setInput(sent.text);
      setMentions(sent.mentions);
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="relative mx-auto max-w-3xl">
        {candidates.length > 0 && (
          <div role="listbox" aria-label="Mention a bot" className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="px-2 py-1 text-xs text-muted-foreground">Hand off to</p>
            {candidates.map((b, i) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(b);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-accent text-accent-foreground")}
              >
                <AtSignIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">{b.name}</span>
                {b.purpose && <span className="truncate text-xs text-muted-foreground">{b.purpose}</span>}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="rounded-2xl border bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30"
        >
          {mentions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {mentions.map((m) => (
                <span key={m.id} className="inline-flex h-6 items-center gap-1 rounded-full bg-secondary pr-1 pl-2 text-xs font-medium text-secondary-foreground">
                  @{m.name}
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    className="rounded-full p-0.5 hover:bg-foreground/10"
                    onClick={() => setMentions(mentions.filter((x) => x.id !== m.id))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Textarea
            ref={textarea}
            autoFocus
            rows={1}
            value={input}
            placeholder={`Message ${bot.name}…`}
            aria-label={`Message ${bot.name}`}
            className="max-h-60 min-h-12 resize-none border-0 bg-transparent! px-4 pt-3 shadow-none focus-visible:ring-0"
            onChange={(e) => {
              setInput(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (candidates.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  return setHighlight((active + step + candidates.length) % candidates.length);
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  return pick(candidates[active]!);
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <p className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>@</Kbd> hand off to a bot · <Kbd>Shift</Kbd>
              <Kbd>Enter</Kbd> new line
            </p>
            <Button type="submit" size="icon-sm" className="ml-auto rounded-full" disabled={busy || !input.trim()} aria-label="Send">
              <ArrowUpIcon />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
