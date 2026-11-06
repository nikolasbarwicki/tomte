import { useEffect, useRef, useState, useTransition } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import type { BotSummary } from "@claudebot/contract/events";
import { BotAvatar } from "@/components/bot-avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Kbd } from "@/components/ui/kbd";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";
import { sendMessage, setEffort, setModel } from "./api.ts";
import { bindMentions, type MentionTarget } from "./mentions.ts";

const botRoute = getRouteApi("/bots/$botId");

/**
 * One of the open session's settings in the composer, after the Model Selector pattern. The host does not report the current values,
 * so only choices made here show.
 */
function SessionSetting({ label, options, apply }: { label: string; options: string[]; apply: (value: string) => Promise<boolean> }) {
  const [value, setValue] = useState<string>();
  const [applying, startApplying] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton size="xs" variant="ghost" className="text-xs" disabled={applying} aria-label={value ? `${label}: ${value}` : label} />}>
        {value ? (
          <>
            <span className="hidden text-muted-foreground sm:inline">{label}</span>
            <span className="capitalize">{value}</span>
          </>
        ) : (
          label
        )}
        {applying ? <Spinner /> : <ChevronDownIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={(v: string) =>
              startApplying(async () => {
                if (await apply(v)) setValue(v);
              })
            }
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

export function Composer({ bot, bots }: { bot: BotSummary; bots: BotSummary[] }) {
  const navigate = botRoute.useNavigate();
  const draft = botRoute.useSearch({ select: (s) => s.draft });
  const [input, setInput] = useState(draft ?? "");
  const [caret, setCaret] = useState(input.length);
  const [picked, setPicked] = useState<MentionTarget[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [sending, startSending] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);

  // The draft is now this composer's own text; leave the caret after it so the user can edit or send.
  useEffect(() => {
    if (draft === undefined) return;
    textarea.current?.setSelectionRange(draft.length, draft.length);
    void navigate({ search: (prev) => ({ ...prev, draft: undefined }), replace: true });
  }, []);

  // A bot is mentioned only if it was picked from the menu and its `@Name` is still in the text; names are not unique, so the id
  // comes from the pick, and a hand-typed `@Name` stays plain text.
  const { segments, mentions } = bindMentions(input, picked);
  const typed = input.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const candidates =
    typed === undefined
      ? []
      : bots.filter((b) => b.id !== bot.id && !mentions.some((m) => m.id === b.id) && b.name.toLowerCase().includes(typed.toLowerCase()));
  const active = Math.min(highlight, candidates.length - 1);

  const pick = (b: BotSummary) => {
    const start = caret - typed!.length - 1;
    const after = input.slice(caret);
    const inserted = `@${b.name}${/^\s/.test(after) ? "" : " "}`;
    const next = input.slice(0, start) + inserted + after;
    const at = start + inserted.length;
    setInput(next);
    setPicked([...mentions, { id: b.id, name: b.name }]);
    setCaret(at);
    setHighlight(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(at, at);
    });
  };

  const send = () => {
    const text = input.trim();
    if (!text || sending) return;
    const sent = mentions;
    setInput("");
    setPicked([]);
    setCaret(0);
    startSending(async () => {
      if (!(await sendMessage(text, sent.map((m) => m.id)))) {
        setInput(text);
        setPicked(sent);
      }
    });
  };

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1);

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
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-muted")}
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
            send();
          }}
        >
          <InputGroup className="rounded-2xl bg-background shadow-xs dark:bg-input/30">
            <div className="relative w-full">
              {/* The textarea's own text is transparent; this copy paints it, so mentions can take their bot's color. Stroke rather
                  than a heavier weight embolds them, since a wider glyph would push the caret out of line with the text. */}
              <div
                ref={backdrop}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3 pb-2 text-base break-words whitespace-pre-wrap md:text-sm"
              >
                {segments.map((s, i) => {
                  if (typeof s === "string") return s;
                  const target = bots.find((b) => b.id === s.mention.id);
                  return (
                    <span key={i} style={target && botTheme(target.avatar.stroke)} className="bot-theme text-primary [-webkit-text-stroke:0.5px_currentColor]">
                      {/* The icon sits on the `@` glyph, which keeps its width so the text stays in line with the textarea's; it is a
                          little smaller than the glyph and nudged left, leaving a gap before the name. */}
                      <span className="relative text-transparent [-webkit-text-stroke:0]">
                        @{target && <BotAvatar avatar={target.avatar} className="absolute top-1/2 left-1/2 size-[0.95em] -translate-x-[60%] -translate-y-1/2" />}
                      </span>
                      {s.text.slice(1)}
                    </span>
                  );
                })}
              </div>
              <InputGroupTextarea
                ref={textarea}
                autoFocus
                rows={1}
                value={input}
                placeholder={`Message ${bot.name}…`}
                aria-label={`Message ${bot.name}`}
                className="relative max-h-60 min-h-12 px-4 pt-3 text-transparent caret-foreground"
                onScroll={(e) => {
                  if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
                }}
                onChange={(e) => {
                  setInput(e.target.value);
                  setPicked(bindMentions(e.target.value, picked).mentions);
                  syncCaret(e.target);
                  setHighlight(0);
                }}
                onSelect={(e) => syncCaret(e.currentTarget)}
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
                    if (e.key === "Escape") {
                      e.preventDefault();
                      return setCaret(-1);
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </div>
            <InputGroupAddon align="block-end">
              <SessionSetting label="Model" options={MODELS} apply={setModel} />
              <SessionSetting label="Effort" options={EFFORTS} apply={setEffort} />
              <p className="ml-auto hidden items-center gap-1 text-xs font-normal whitespace-nowrap @xl:flex">
                <Kbd>@</Kbd> hand off to a bot · <Kbd>Shift</Kbd>
                <Kbd>Enter</Kbd> new line
              </p>
              <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto rounded-full @xl:ml-0" disabled={sending || !input.trim()} aria-label="Send">
                {sending ? <Spinner /> : <ArrowUpIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  );
}
