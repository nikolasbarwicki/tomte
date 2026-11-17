import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { BotSummary, HandoffStatus } from "@tomte/contract/events";
import { useState } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Item } from "@/host/transcript.ts";
import { botTheme } from "@/lib/avatars.ts";
import { clockTime, dateTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

import { toolView, type ToolItem, type ToolView } from "./tool-view.ts";

/** The bot's column: what is not a message never runs wider than a reply can. */
export const BOT_COLUMN = "max-w-[min(88%,42rem)]";

const LINE =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mx-1.5 flex w-fit max-w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-0.5 text-[0.8125rem] outline-none focus-visible:ring-3";

const Caret = ({ open }: { open: boolean }) => (
  <CaretRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
);

/**
 * Tool calls the bot made in a row, as one line that opens into the steps. The host reports no tool results, so the newest call of
 * a live turn is the one running. A lone finished call is its own line.
 */
export function Steps({ tools, running }: { tools: ToolItem[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const last = tools.at(-1)!;
  if (tools.length === 1 && !running) return <ToolStep tool={last} live={false} />;
  const live = toolView(last);
  const Lead = toolView(tools[0]!).icon;
  return (
    <div className="grid gap-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={LINE}>
        {running ? <Spinner className="text-primary size-3.5" /> : <Lead className="size-3.5" />}
        {running ? (
          <span className="shimmer min-w-0 truncate">
            {live.doing}
            {live.target && ` ${live.target}`}…
          </span>
        ) : (
          <span className="truncate">{tools.length} steps</span>
        )}
        {running && (
          <span className="text-muted-foreground/70 shrink-0 tabular-nums">
            · step {tools.length}
          </span>
        )}
        <Caret open={open} />
      </button>
      {open && (
        <ol className="border-border ml-2 grid gap-2 border-l py-1 pl-4">
          {tools.map((tool, i) => (
            <li key={i}>
              <ToolStep tool={tool} live={running && i === tools.length - 1} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ToolStep({ tool, live }: { tool: ToolItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  const v = toolView(tool);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:text-foreground focus-visible:ring-ring/50 -mx-1 flex w-fit max-w-full items-baseline gap-1.5 rounded px-1 text-left text-[0.8125rem] outline-none focus-visible:ring-3"
      >
        <v.icon className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5" />
        <span className={cn("text-foreground/85 shrink-0", live && "shimmer")}>
          {live ? v.doing : v.done}
        </span>
        {v.target && (
          <span
            className={cn("text-muted-foreground min-w-0 truncate", v.code && "font-mono text-xs")}
          >
            {v.target}
          </span>
        )}
      </button>
      {open && (
        <div className={cn("bg-muted/50 rounded-lg px-3 py-2", BOT_COLUMN)}>
          <Args view={v} />
        </div>
      )}
    </div>
  );
}

/** A tool call's arguments as a two-column list; long values wrap, code stays mono. */
function Args({ view }: { view: ToolView }) {
  if (view.args.length === 0) return <p className="text-muted-foreground text-xs">No arguments.</p>;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {view.args.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-foreground/90 font-mono break-words whitespace-pre-wrap">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const HANDOFF_STATE: Record<HandoffStatus, { label: string; dot: string }> = {
  submitted: { label: "Sent", dot: "bg-primary" },
  working: { label: "Working", dot: "bg-primary" },
  "input-required": { label: "Needs an answer", dot: "bg-amber-500" },
  completed: { label: "Done", dot: "bg-emerald-600 dark:bg-emerald-400" },
  failed: { label: "Failed", dot: "bg-destructive" },
  canceled: { label: "Cancelled", dot: "bg-destructive" },
};

/**
 * A handoff in the same grammar as the bot's work: one line (direction, the other bot, the subject, where it stands) that opens
 * into the brief. One waiting on the owner opens by itself. `other`: the bot on the far side, when it still exists; the line
 * takes its color.
 */
export function HandoffLine({
  item,
  other,
}: {
  item: Extract<Item, { kind: "handoff" }>;
  other: BotSummary | undefined;
}) {
  const received = item.direction === "received";
  const [open, setOpen] = useState(item.status === "input-required");
  const Arrow = received ? ArrowDownLeftIcon : ArrowUpRightIcon;
  const state = HANDOFF_STATE[item.status];
  return (
    <div
      style={other && botTheme(other.avatar.color)}
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5", other && "bot-theme")}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={LINE}>
        <Arrow className="size-3.5 shrink-0" />
        <span className="shrink-0">{received ? "From" : "Handed to"}</span>
        <span className="text-foreground inline-flex shrink-0 items-center gap-1 font-medium">
          {other && <BotAvatar avatar={other.avatar} className="size-4" />}
          {item.bot}
        </span>
        {item.title && <span className="text-foreground/80 min-w-0 truncate">{item.title}</span>}
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium">
          <span className={cn("size-1.5 rounded-full", state.dot)} aria-hidden />
          {state.label}
        </span>
        <Caret open={open} />
      </button>
      {open && (
        <div className={cn("border-primary/40 ml-2 grid gap-1.5 border-l py-1 pl-4", BOT_COLUMN)}>
          <p className="text-foreground/90 text-sm leading-[1.45] text-pretty whitespace-pre-wrap">
            {item.text}
          </p>
          {other && (
            <Link
              to="/bots/$botId"
              params={{ botId: other.id }}
              className="text-primary w-fit text-xs font-medium hover:underline"
            >
              Open {item.bot}'s chat
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a message's hover shows beside its bubble: a copy button and, when known, the time it was sent. Rendered inside the bubble
 * and placed outside its outer edge (`align` is the bubble's side), vertically centred, so it takes no room in the thread. Hidden
 * until the message (`group/message`) is hovered or focused.
 */
export function MessageMeta({
  text,
  at,
  align = "start",
}: {
  text: string;
  at?: number | undefined;
  align?: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "text-muted-foreground absolute top-1/2 flex -translate-y-1/2 items-center gap-1 text-xs whitespace-nowrap opacity-0 transition-opacity duration-150 group-focus-within/message:opacity-100 group-hover/message:opacity-100",
        align === "end" ? "right-full mr-1.5 flex-row-reverse" : "left-full ml-1.5",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={copied ? "Copied" : "Copy message"}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                void navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            />
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy message"}</TooltipContent>
      </Tooltip>
      {at !== undefined && (
        <Tooltip>
          <TooltipTrigger
            render={<time dateTime={new Date(at).toISOString()} className="tabular-nums" />}
          >
            {clockTime(at)}
          </TooltipTrigger>
          <TooltipContent>{dateTime(at)}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
