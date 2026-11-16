import type { BotSummary } from "@claudebot/contract/events";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowUpIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { sendMessage } from "@/host/api.ts";
import { useWork } from "@/host/hooks.ts";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

import { bindMentions, type MentionTarget } from "./mentions.ts";
import { needsYouItems } from "./model.ts";

const botRoute = getRouteApi("/bots/$botId");

export function Composer({ bot, bots }: { bot: BotSummary; bots: BotSummary[] }) {
  const navigate = botRoute.useNavigate();
  const draft = botRoute.useSearch({ select: (s) => s.draft });
  const draftEvent = botRoute.useSearch({ select: (s) => s.draftEvent });
  const [input, setInput] = useState(draft ?? "");
  // The needs-you item the text answers: set with a draft from "Answer…", kept while it is edited, dropped when the draft is
  // replaced or the text emptied. The host closes the item when the message reaches the bot, not before.
  const [answering, setAnswering] = useState(draft === undefined ? undefined : draftEvent);
  const [caret, setCaret] = useState(input.length);
  const [picked, setPicked] = useState<MentionTarget[]>([]);
  // The item still open: one handled elsewhere meanwhile is no longer answered, so the text goes out as a plain message.
  const answered = needsYouItems(useWork(), bot.id).find((i) => i.id === answering);
  const [highlight, setHighlight] = useState(0);
  const [sending, startSending] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);

  // A draft that arrives while the composer is open (the Needs you bar's "Answer…") replaces what was typed.
  const [takenDraft, setTakenDraft] = useState(draft);
  if (draft !== takenDraft) {
    setTakenDraft(draft);
    if (draft !== undefined) {
      setInput(draft);
      setCaret(draft.length);
      setPicked([]);
      setAnswering(draftEvent);
    }
  }
  // The draft is now this composer's own text; leave the caret after it so the user can edit or send.
  const takeDraft = useEffectEvent((text: string) => {
    textarea.current?.focus();
    textarea.current?.setSelectionRange(text.length, text.length);
    void navigate({
      search: (prev) => ({ ...prev, draft: undefined, draftEvent: undefined }),
      replace: true,
    });
  });
  useEffect(() => {
    if (draft !== undefined) takeDraft(draft);
  }, [draft]);

  // A bot is mentioned only if it was picked from the menu and its `@Name` is still in the text; names are not unique, so the id
  // comes from the pick, and a hand-typed `@Name` stays plain text.
  const { segments, mentions } = bindMentions(input, picked);
  const typed = input.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const candidates =
    typed === undefined
      ? []
      : bots.filter(
          (b) =>
            b.id !== bot.id &&
            !mentions.some((m) => m.id === b.id) &&
            b.name.toLowerCase().includes(typed.toLowerCase()),
        );
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
    const eventId = answered?.id;
    setInput("");
    setPicked([]);
    setCaret(0);
    setAnswering(undefined);
    startSending(async () => {
      if (
        !(await sendMessage(
          text,
          sent.map((m) => m.id),
          eventId,
        ))
      ) {
        setInput(text);
        setPicked(sent);
        setAnswering(eventId);
      }
    });
  };

  const syncCaret = (el: HTMLTextAreaElement) =>
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1);

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="relative mx-auto max-w-3xl">
        {candidates.length > 0 && (
          <div
            role="listbox"
            aria-label="Mention a bot"
            className="bg-popover text-popover-foreground ring-foreground/10 absolute bottom-full left-0 z-10 mb-2 w-72 rounded-lg p-1 shadow-md ring-1"
          >
            <p className="text-muted-foreground px-2 py-1 text-xs">Hand off to</p>
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
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  i === active && "bg-muted",
                )}
              >
                <BotAvatar avatar={b.avatar} className="size-5" />
                <span className="shrink-0 font-medium">{b.name}</span>
                {b.purpose && (
                  <span className="text-muted-foreground truncate text-xs">{b.purpose}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {answered && (
          <p className="text-muted-foreground truncate px-4 pb-1 text-xs">
            Answering <span className="font-medium">{answered.source}</span> · {answered.title}
          </p>
        )}
        <form
          className="@container"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <InputGroup className="bg-background dark:bg-input/30 rounded-2xl shadow-xs">
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
                    <span
                      key={i}
                      style={target && botTheme(target.avatar.stroke)}
                      className="bot-theme text-primary [-webkit-text-stroke:0.5px_currentColor]"
                    >
                      {/* The icon sits on the `@` glyph, which keeps its width so the text stays in line with the textarea's; it is a
                          little smaller than the glyph and nudged left, leaving a gap before the name. */}
                      <span className="relative text-transparent [-webkit-text-stroke:0]">
                        @
                        {target && (
                          <BotAvatar
                            avatar={target.avatar}
                            className="absolute top-1/2 left-1/2 size-[0.95em] -translate-x-[60%] -translate-y-1/2"
                          />
                        )}
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
                className="caret-foreground relative max-h-60 min-h-12 px-4 pt-3 text-transparent"
                onScroll={(e) => {
                  if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
                }}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!e.target.value.trim()) setAnswering(undefined);
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
              <p className="hidden items-center gap-1 text-xs font-normal whitespace-nowrap @xl:flex">
                <Kbd>@</Kbd> hand off to a bot · <Kbd>Shift</Kbd>
                <Kbd>Enter</Kbd> new line
              </p>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="ml-auto rounded-full"
                disabled={sending || !input.trim()}
                aria-label="Send"
              >
                {sending ? <Spinner /> : <ArrowUpIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  );
}
