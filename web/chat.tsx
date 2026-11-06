import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, ChevronDownIcon, MessageSquarePlusIcon, PanelRightIcon, XIcon } from "lucide-react";
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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { BotSummary, ContextEvent, FilesEvent, MemoryScope, Routine } from "./events.ts";
import { act } from "./api.ts";
import { botTheme } from "./avatars.ts";
import { BotAvatar } from "./bot-avatar.tsx";
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
      <div className="bot-theme flex min-w-0 flex-1 flex-col" style={botTheme(bot.avatar.stroke)}>
        <AppBar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{bot.name}</h1>
            {bot.purpose && <p className="truncate text-xs text-muted-foreground">{bot.purpose}</p>}
          </div>
          <ContextMeter context={context} />
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
        <Transcript bot={bot} bots={bots} items={items} busy={busy} onShowBrowser={showBrowser} />
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

/** How full the session's context window is, after the Context pattern. */
function ContextMeter({ context }: { context: ContextEvent | undefined }) {
  const pct = context?.percentage ?? 0;
  const high = pct >= 80;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        render={<Button variant="ghost" size="sm" className={cn("tabular-nums", high ? "text-destructive" : "text-muted-foreground")} />}
      >
        {context ? `${pct}%` : "–"}
        <span className="hidden sm:inline">context</span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex flex-col gap-3">
        {context ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Context</span>
              <span className="text-muted-foreground tabular-nums">
                {kTokens(context.tokens)} / {kTokens(context.max)}
              </span>
            </div>
            <Progress value={pct} aria-label="Context used" className={cn(high && "**:data-[slot=progress-indicator]:bg-destructive")} />
            {high && <p className="text-muted-foreground">Consider a new session.</p>}
          </>
        ) : (
          <p className="text-muted-foreground">Context usage appears after the next reply.</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * One of the open session's settings in the composer, after the Model Selector pattern. The host does not report the current values,
 * so only choices made here show.
 */
function SessionSetting({ label, options, apply }: { label: string; options: string[]; apply: (value: string) => Promise<boolean> }) {
  const [value, setValue] = useState<string>();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton size="xs" variant="ghost" className="text-xs" aria-label={value ? `${label}: ${value}` : label} />}>
        {value ? (
          <>
            <span className="hidden text-muted-foreground sm:inline">{label}</span>
            <span className="capitalize">{value}</span>
          </>
        ) : (
          label
        )}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={async (v: string) => {
              if (await apply(v)) setValue(v);
            }}
          >
            {options.map((o) => (
              <DropdownMenuRadioItem key={o} value={o} closeOnClick className="capitalize">
                {o}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "max"];

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
                style={botTheme(b.avatar.stroke)}
                className={cn("bot-theme flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-accent text-accent-foreground")}
              >
                <BotAvatar avatar={b.avatar} className="size-5" />
                <span className="shrink-0 font-medium">{b.name}</span>
                {b.purpose && <span className="truncate text-xs text-muted-foreground">{b.purpose}</span>}
              </button>
            ))}
          </div>
        )}
        <form
          className="@container"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <InputGroup className="rounded-2xl bg-background shadow-xs dark:bg-input/30">
            {mentions.length > 0 && (
              <InputGroupAddon align="block-start" className="flex-wrap pt-3">
                {mentions.map((m) => {
                  const target = bots.find((b) => b.id === m.id);
                  return (
                    <span key={m.id} style={target && botTheme(target.avatar.stroke)} className="bot-theme inline-flex h-6 items-center gap-1 rounded-full bg-secondary pr-1 pl-1 text-xs font-medium text-secondary-foreground">
                      {target && <BotAvatar avatar={target.avatar} className="size-4" />}
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
                  );
                })}
              </InputGroupAddon>
            )}
            <InputGroupTextarea
              ref={textarea}
              autoFocus
              rows={1}
              value={input}
              placeholder={`Message ${bot.name}…`}
              aria-label={`Message ${bot.name}`}
              className="max-h-60 min-h-12 px-4 pt-3"
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
            <InputGroupAddon align="block-end">
              <SessionSetting label="Model" options={MODELS} apply={(model) => act("/api/model", { model })} />
              <SessionSetting label="Effort" options={EFFORTS} apply={(effort) => act("/api/effort", { effort })} />
              <p className="ml-auto hidden items-center gap-1 text-xs font-normal whitespace-nowrap @xl:flex">
                <Kbd>@</Kbd> hand off to a bot · <Kbd>Shift</Kbd>
                <Kbd>Enter</Kbd> new line
              </p>
              <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto rounded-full @xl:ml-0" disabled={busy || !input.trim()} aria-label="Send">
                <ArrowUpIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  );
}
