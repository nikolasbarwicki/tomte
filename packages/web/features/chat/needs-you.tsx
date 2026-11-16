import type { BotSummary } from "@claudebot/contract/events";
import { getRouteApi } from "@tanstack/react-router";
import {
  BellRingIcon,
  ChevronDownIcon,
  HandIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { sendMessage } from "@/host/api.ts";
import { useChat, useWork } from "@/host/hooks.ts";
import { cn } from "@/lib/utils";

import { answer, answerWait, dismissItem } from "./api.ts";
import { EXTERNAL_ICONS } from "./external-icons.ts";
import {
  cardElementId,
  itemActions,
  needsYouRows,
  rowLabels,
  type ItemAction,
  type NeedsYouItem,
  type RequestAction,
  type RequestRow,
} from "./model.ts";

const botRoute = getRouteApi("/bots/$botId");

const REQUEST_ICONS: Record<string, LucideIcon> = {
  Takeover: HandIcon,
  Approval: ShieldQuestionIcon,
  Question: MessageCircleQuestionIcon,
};

const showCard = (request: RequestRow) =>
  document.getElementById(cardElementId(request.id))?.scrollIntoView({ block: "center" });

/** Typing, or a control that owns the key: a shortcut there would steal a keystroke or fire twice. */
function ownsKeys(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
    return true;
  return key === "Enter" && !!target.closest("button, a[href], summary");
}

/**
 * Pinned between the app bar and the transcript while the bot has open items: events that wait for the user, and the request
 * cards of the chat (an approval, a takeover, a question). Collapsed it shows how many and what kind; expanded, one row per
 * item, events first, oldest first, with a cursor. j and k move it, Enter runs an event's first button and e dismisses it,
 * whenever the list is expanded and focus is not in a field. A request row has the card's own buttons, but Enter only scrolls
 * to its card and e does nothing: a stray key press must never approve a tool or hand over the browser.
 */
export function NeedsYou({ bot }: { bot: BotSummary }) {
  const work = useWork();
  const { items: chat } = useChat();
  const rows = useMemo(() => needsYouRows(work, bot.id, chat), [work, bot.id, chat]);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState(0);
  const navigate = botRoute.useNavigate();
  const at = Math.min(cursor, rows.length - 1);
  // An item whose answer is on its way: a second press must not send it twice.
  const inFlight = useRef(new Set<string>());

  const run = async (item: NeedsYouItem, action: ItemAction) => {
    if ("draft" in action)
      return void navigate({
        search: (prev) => ({ ...prev, draft: action.draft, draftEvent: item.id }),
        replace: true,
      });
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    try {
      // The host routes it (to the bot's pending question about the item, or to the bot) and closes the item once the bot has it.
      await sendMessage(action.message, [], item.id, action.answer);
    } finally {
      inFlight.current.delete(item.id);
    }
  };
  const dismiss = (item: NeedsYouItem) => void dismissItem(bot.id, item.id);
  const answerRequest = async (request: RequestRow, action: RequestAction) => {
    if (inFlight.current.has(request.id)) return;
    inFlight.current.add(request.id);
    try {
      await (request.kind === "wait"
        ? answerWait(request.id, action.value)
        : answer(request.id, action.value));
    } finally {
      inFlight.current.delete(request.id);
    }
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const row = rows[at];
    if (!row || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ownsKeys(e.target, e.key))
      return;
    if (e.key === "j") setCursor(Math.min(at + 1, rows.length - 1));
    else if (e.key === "k") setCursor(Math.max(at - 1, 0));
    else if (e.key === "Enter") {
      // An event's first button is safe to run from the keyboard. A request's are not: Enter only shows its card.
      if (row.type === "event") void run(row.item, itemActions(row.item)[0]!);
      else showCard(row.request);
    } else if (e.key === "e" && row.type === "event") dismiss(row.item);
    else return;
    e.preventDefault();
  });
  useEffect(() => {
    if (!expanded) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Needs you"
      className="shrink-0 border-b bg-amber-500/10 text-sm text-amber-950 dark:text-amber-100"
    >
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
        onClick={(e) => {
          setExpanded(!expanded);
          // Mouse focus would make the next Enter press this button instead of running the item.
          if (e.detail > 0) e.currentTarget.blur();
        }}
      >
        <BellRingIcon className="size-4 shrink-0" />
        <span className="font-medium">Needs you</span>
        <span className="rounded-full bg-amber-500/25 px-1.5 text-xs font-semibold tabular-nums">
          {rows.length}
        </span>
        <span className="min-w-0 flex-1 truncate opacity-80">{rowLabels(rows).join(", ")}</span>
        <ChevronDownIcon
          className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <ul className="max-h-60 overflow-y-auto border-t border-amber-500/20 pb-1">
          {rows.map((row, i) => {
            const current = i === at;
            const rowClass = cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 px-4 py-1.5",
              current ? "border-amber-600 bg-amber-500/15" : "border-transparent",
            );
            if (row.type === "request") {
              const { request } = row;
              const Icon = REQUEST_ICONS[request.label] ?? ShieldQuestionIcon;
              return (
                <li
                  key={request.id}
                  aria-current={current}
                  onClick={() => setCursor(i)}
                  className={rowClass}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 basis-48 truncate">
                    <span className="font-semibold">{request.label}</span> · {request.title}
                  </span>
                  {request.actions.map((action) => (
                    <Button
                      key={action.value}
                      size="xs"
                      variant="outline"
                      onClick={() => void answerRequest(request, action)}
                    >
                      {action.label}
                    </Button>
                  ))}
                  <Button size="xs" variant="ghost" onClick={() => showCard(request)}>
                    Show
                    {current && <Kbd className="ml-1">↵</Kbd>}
                  </Button>
                </li>
              );
            }
            const { item } = row;
            const Icon = EXTERNAL_ICONS[item.kind];
            const actions = itemActions(item);
            return (
              <li
                key={item.id}
                aria-current={current}
                onClick={() => setCursor(i)}
                className={rowClass}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 basis-48 truncate">
                  <span className="font-semibold">{item.source}</span> · {item.title}
                </span>
                {actions.map((action, n) => (
                  <Button
                    key={action.label}
                    size="xs"
                    variant={n === 0 ? "default" : "outline"}
                    onClick={() => void run(item, action)}
                  >
                    {action.label}
                    {current && n === 0 && <Kbd className="ml-1">↵</Kbd>}
                  </Button>
                ))}
                <Button size="xs" variant="ghost" onClick={() => dismiss(item)}>
                  Dismiss
                  {current && <Kbd className="ml-1">e</Kbd>}
                </Button>
              </li>
            );
          })}
          <li className="text-muted-foreground px-4 pt-1 text-xs">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>↵</Kbd> first action, or show a request's card ·{" "}
            <Kbd>e</Kbd> dismiss
          </li>
        </ul>
      )}
    </section>
  );
}
