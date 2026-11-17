import { ArrowUpIcon, FileIcon, FolderIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { getRouteApi } from "@tanstack/react-router";
import type { Attachment, BotSummary } from "@tomte/contract/events";
import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { sendMessage } from "@/host/api.ts";
import { useOpenBotId, useWork } from "@/host/hooks.ts";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

import { attach } from "./api.ts";
import { draftsFromInput, draftsFromTransfer, type DraftAttachment } from "./attachments.ts";
import { bindMentions, type MentionTarget } from "./mentions.ts";
import { ModelChip } from "./model-chip.tsx";
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
  // The host sends to the chat it streams, which is another bot's for a moment after switching.
  const streamed = useOpenBotId() === bot.id;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  // Files and folders to send with the message; each is saved on the host when the message is sent, and keeps where it was
  // saved (`saved`) when the send fails, so sending again does not save it twice.
  const [drafts, setDrafts] = useState<(DraftAttachment & { saved?: Attachment })[]>([]);
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const addDrafts = (more: DraftAttachment[]) => {
    if (more.length) setDrafts((ds) => [...ds, ...more]);
    textarea.current?.focus();
  };

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
    if ((!text && drafts.length === 0) || sending || !streamed) return;
    const sent = mentions;
    const eventId = answered?.id;
    const pending = drafts;
    setInput("");
    setPicked([]);
    setCaret(0);
    setAnswering(undefined);
    setDrafts([]);
    startSending(async () => {
      const saved: Attachment[] = [];
      for (const d of pending) {
        const a = d.saved ?? (await attach(d.files));
        if (!a) break;
        saved.push(a);
      }
      const ok =
        saved.length === pending.length &&
        (await sendMessage(
          text,
          sent.map((m) => m.id),
          eventId,
          undefined,
          saved,
        ));
      if (!ok) {
        setInput(text);
        setPicked(sent);
        setAnswering(eventId);
        setDrafts(pending.map((d, i) => ({ ...d, ...(saved[i] && { saved: saved[i] }) })));
      }
    });
  };

  const syncCaret = (el: HTMLTextAreaElement) =>
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1);

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="relative mx-auto max-w-220">
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
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const { files } = e.currentTarget;
              if (files) addDrafts(draftsFromInput(files, false));
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
              if (files) addDrafts(draftsFromInput(files, true));
              e.currentTarget.value = "";
            }}
          />
          <InputGroup
            data-dragging={dragging || undefined}
            className={cn(
              "bg-card border-border/70 rounded-2xl shadow-(--composer-shadow) transition-[border-color,background-color]",
              // Focus darkens the border a step: no ring, and nothing in the bot's color.
              "has-[[data-slot=input-group-control]:focus-visible]:border-foreground/20 has-[[data-slot=input-group-control]:focus-visible]:ring-0",
              "data-dragging:border-foreground/30 data-dragging:bg-muted/50",
            )}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(e) => {
              const to = e.relatedTarget;
              if (!(to instanceof Node && e.currentTarget.contains(to))) setDragging(false);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(false);
              void draftsFromTransfer(e.dataTransfer).then(addDrafts);
            }}
          >
            {drafts.length > 0 && (
              <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-3 pt-3">
                {drafts.map((d) => (
                  <span
                    key={d.key}
                    className="bg-muted text-foreground inline-flex h-7 max-w-60 items-center gap-1.5 rounded-lg pr-0.5 pl-2 text-xs"
                  >
                    {d.folder ? (
                      <FolderIcon className="text-muted-foreground shrink-0" />
                    ) : (
                      <FileIcon className="text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">{d.name}</span>
                    {d.folder && (
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {d.files.length} {d.files.length === 1 ? "file" : "files"}
                      </span>
                    )}
                    <InputGroupButton
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground size-6 rounded-md"
                      aria-label={`Remove ${d.name}`}
                      onClick={() => {
                        setDrafts((ds) => ds.filter((x) => x.key !== d.key));
                        textarea.current?.focus();
                      }}
                    >
                      <XIcon />
                    </InputGroupButton>
                  </span>
                ))}
              </InputGroupAddon>
            )}
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
                      style={target && botTheme(target.avatar.color)}
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
                onPaste={(e) => {
                  if (e.clipboardData.files.length === 0) return;
                  e.preventDefault();
                  void draftsFromTransfer(e.clipboardData).then(addDrafts);
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
              <ModelChip bot={bot} />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground rounded-full"
                      aria-label="Attach files or a folder"
                    />
                  }
                >
                  <PlusIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-44">
                  <DropdownMenuItem onClick={() => filePicker.current?.click()}>
                    <FileIcon /> Files…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => folderPicker.current?.click()}>
                    <FolderIcon /> Folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="ml-auto rounded-full"
                disabled={sending || !streamed || (!input.trim() && drafts.length === 0)}
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
