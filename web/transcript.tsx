import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Streamdown } from "streamdown";
import {
  AlarmClockIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GlobeIcon,
  HandIcon,
  MegaphoneIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  WrenchIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item as ItemRow, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import type { BotSummary, ServerEvent, WaitAction } from "./events.ts";
import { act } from "./api.ts";
import { botTheme } from "./avatars.ts";
import { BotAvatar } from "./bot-avatar.tsx";
import { kTokens } from "./format.ts";
import { bindMentions } from "./mentions.ts";

export type Item =
  | { kind: "user"; text: string; mentions?: { id: string; name: string }[] }
  | { kind: "assistant" | "error" | "info" | "update"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "ask"; id: string; question: string; answer?: string }
  | { kind: "approve"; id: string; tool: string; reason: string; input: string; answer?: string }
  | { kind: "wait"; id: string; waitKind: string; title: string; detail?: string; actions: WaitAction[]; resolved?: string }
  | { kind: "session" }
  | { kind: "routine"; name: string; trigger: string }
  | { kind: "handoff"; direction: "sent" | "received"; bot: string; botId?: string; title: string; status: string; text: string };

export function reduce(items: Item[], e: ServerEvent): Item[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case "user":
      return [...items, { kind: "user", text: e.text, mentions: e.mentions }];
    case "text_start":
      return [...items, { kind: "assistant", text: "" }];
    case "delta":
      return last?.kind === "assistant"
        ? [...items.slice(0, -1), { ...last, text: last.text + e.text }]
        : [...items, { kind: "assistant", text: e.text }];
    case "tool":
      return [...items, { kind: "tool", name: e.name, input: e.input }];
    case "ask":
      return [...items, { kind: "ask", id: e.id, question: e.question }];
    case "approve":
      return [...items, { kind: "approve", id: e.id, tool: e.tool, reason: e.reason, input: e.input }];
    case "answered":
      return items.map((i) => ((i.kind === "ask" || i.kind === "approve") && i.id === e.id ? { ...i, answer: e.value } : i));
    case "wait":
      return [...items, { kind: "wait", id: e.id, waitKind: e.kind, title: e.title, detail: e.detail, actions: e.actions }];
    case "wait_resolved":
      return items.map((i) => (i.kind === "wait" && i.id === e.id ? { ...i, resolved: e.label } : i));
    case "error":
      return [...items, { kind: "error", text: e.message }];
    case "info":
      return [...items, { kind: "info", text: e.text }];
    case "update":
      return [...items, { kind: "update", text: e.text }];
    case "session":
      return [...items, { kind: "session" }];
    case "routine":
      return [...items, { kind: "routine", name: e.name, trigger: e.trigger }];
    case "handoff":
      return [...items, { kind: "handoff", direction: e.direction, bot: e.bot, botId: e.botId, title: e.title, status: e.status, text: e.text }];
    case "compacted":
      return [...items, { kind: "info", text: `Context compacted (${e.trigger}) · ${kTokens(e.preTokens)} tokens summarized` }];
    case "done":
    case "reset":
    case "notify":
    case "context":
      return items;
  }
}

type ToolItem = Extract<Item, { kind: "tool" }>;
/** What the thread renders: items as they came, except back-to-back tool calls collapse into one trace of steps. */
type Row = Exclude<Item, ToolItem> | { kind: "steps"; tools: ToolItem[] };

/** Scroller items use `content-visibility: auto`, whose paint containment would clip a handoff card's shadow. */
const UNCLIPPED = "[content-visibility:visible]";

function toRows(items: Item[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (item.kind !== "tool") rows.push(item);
    else if (last?.kind === "steps") last.tools.push(item);
    else rows.push({ kind: "steps", tools: [item] });
  }
  return rows;
}

/** The thread. Message Scroller follows new output while the reader is at the live edge and anchors each new user turn near the top. */
export function Transcript({ bot, bots, items, busy, onShowBrowser }: { bot: BotSummary; bots: BotSummary[]; items: Item[]; busy: boolean; onShowBrowser: () => void }) {
  if (items.length === 0 && !busy) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>Message {bot.name}</EmptyTitle>
          <EmptyDescription>{bot.purpose || "Tell it what this bot is for and what to do first. It remembers how you like things done."}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const rows = toRows(items);
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-3xl gap-4 px-4 py-6">
            {rows.map((row, i) => (
              <MessageScrollerItem key={i} messageId={String(i)} scrollAnchor={row.kind === "user"} className={cn(row.kind === "handoff" && UNCLIPPED)}>
                <RowView row={row} running={busy && i === rows.length - 1} bots={bots} onShowBrowser={onShowBrowser} />
              </MessageScrollerItem>
            ))}
            {busy && (
              <MessageScrollerItem messageId="working">
                <Marker role="status">
                  <MarkerIcon>
                    <Spinner className="text-primary" />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">{bot.name} is working…</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** `running`: the row is the live edge of a turn still in progress. */
function RowView({ row, running, bots, onShowBrowser }: { row: Row; running: boolean; bots: BotSummary[]; onShowBrowser: () => void }) {
  switch (row.kind) {
    case "user": {
      const mentions = row.mentions ?? [];
      const bound = bindMentions(row.text, mentions);
      const segments = bound.segments;
      const leading = mentions.filter((m) => !bound.mentions.includes(m)).map((m) => ({ mention: m, text: `@${m.name}` }));
      return (
        <Message align="end">
          <MessageContent>
            <Bubble align="end">
              <BubbleContent className="whitespace-pre-wrap">
                {[...leading.flatMap((s) => [s, " "]), ...segments].map((s, i) => {
                  if (typeof s === "string") return s;
                  const target = bots.find((b) => b.id === s.mention.id);
                  return target ? (
                    <Link
                      key={i}
                      to="/bots/$botId"
                      params={{ botId: target.id }}
                      style={botTheme(target.avatar.stroke)}
                      className="bot-theme inline-flex items-baseline gap-1 rounded-full bg-background px-1.5 font-semibold text-primary transition-colors hover:bg-secondary"
                    >
                      <BotAvatar avatar={target.avatar} className="size-[1.1em] self-center" />
                      {s.text.slice(1)}
                    </Link>
                  ) : (
                    <span key={i} className="font-semibold">
                      {s.text}
                    </span>
                  );
                })}
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    }
    case "assistant":
      return (
        <Message>
          <MessageContent>
            <Bubble variant="muted" className="max-w-[60%]">
              <BubbleContent className="w-full">
                <Streamdown linkSafety={{ enabled: false }}>{row.text}</Streamdown>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "steps":
      return <Steps tools={row.tools} running={running} />;
    case "error":
      return (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription className="break-words whitespace-pre-wrap">{row.text}</AlertDescription>
        </Alert>
      );
    case "update":
      return (
        <Alert>
          <MegaphoneIcon />
          <AlertDescription className="text-foreground">{row.text}</AlertDescription>
        </Alert>
      );
    case "info":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerContent>{row.text}</MarkerContent>
        </Marker>
      );
    case "session":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerContent>New session · earlier messages are no longer in the bot's context</MarkerContent>
        </Marker>
      );
    case "routine":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerIcon>
            <AlarmClockIcon className="size-3.5" />
          </MarkerIcon>
          <MarkerContent>
            Routine <span className="font-semibold text-foreground">{row.name}</span> · {row.trigger === "manual" ? "test run" : "scheduled"}
          </MarkerContent>
        </Marker>
      );
    case "handoff":
      return <HandoffCard item={row} other={bots.find((b) => b.id === row.botId)} />;
    case "wait":
      return <WaitCard item={row} onShowBrowser={onShowBrowser} />;
    case "ask":
      return <AskCard item={row} />;
    case "approve":
      return <ApproveCard item={row} />;
  }
}

/** Tool calls the bot made in a row. The host reports no tool results, so the newest call of a live turn is the one running. */
function Steps({ tools, running }: { tools: ToolItem[]; running: boolean }) {
  return (
    <Trace>
      {tools.map((tool, i) => (
        <TraceCollapsible key={i}>
          <TraceCollapsibleTrigger>
            <TraceLine status={running && i === tools.length - 1 ? "running" : undefined}>
              <TraceIcon>
                <WrenchIcon />
              </TraceIcon>
              <TraceTitle className="font-mono text-xs">{tool.name}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">{tool.input}</pre>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ))}
    </Trace>
  );
}

/**
 * Something the bot is blocked on, after the Confirmation pattern. Open while `answer` is undefined: outlined, with `actions`.
 * Settled: muted, with the answer in their place. `footer` spans the full width below.
 */
function Request({
  icon,
  title,
  description,
  answer,
  actions,
  footer,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  answer: string | undefined;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const open = answer === undefined;
  return (
    <ItemRow variant={open ? "outline" : "muted"} size="sm">
      <ItemMedia variant="icon" className={cn(open && "text-primary")}>
        {icon}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">{title}</ItemTitle>
        {description && <ItemDescription className="line-clamp-none whitespace-pre-wrap">{description}</ItemDescription>}
      </ItemContent>
      {open ? (
        actions && <ItemActions className="flex-wrap">{actions}</ItemActions>
      ) : (
        <ItemActions className="text-xs text-muted-foreground">
          <CircleCheckIcon className="size-3.5" /> {answer}
        </ItemActions>
      )}
      {footer && <ItemFooter>{footer}</ItemFooter>}
    </ItemRow>
  );
}

function WaitCard({ item, onShowBrowser }: { item: Extract<Item, { kind: "wait" }>; onShowBrowser: () => void }) {
  const takeover = item.waitKind === "takeover";
  return (
    <Request
      icon={takeover ? <HandIcon /> : <ShieldQuestionIcon />}
      title={item.title}
      description={item.detail}
      answer={item.resolved}
      actions={
        <>
          {item.actions.map((a, i) => (
            <Button key={a.id} size="sm" variant={i === 0 ? "default" : "outline"} onClick={() => act("/api/waits/answer", { id: item.id, action: a.id })}>
              {a.label}
            </Button>
          ))}
          {takeover && (
            <Button size="sm" variant="ghost" onClick={onShowBrowser}>
              <GlobeIcon /> Open browser
            </Button>
          )}
        </>
      }
    />
  );
}

function AskCard({ item }: { item: Extract<Item, { kind: "ask" }> }) {
  const [reply, setReply] = useState("");
  return (
    <Request
      icon={<MessageCircleQuestionIcon />}
      title="The bot asks"
      description={item.question}
      answer={item.answer}
      footer={
        item.answer === undefined && (
          <form
            className="flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act("/api/answer", { id: item.id, value: reply });
            }}
          >
            <Input autoFocus placeholder="Your answer" value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button type="submit" disabled={!reply.trim()}>
              Answer
            </Button>
          </form>
        )
      }
    />
  );
}

function ApproveCard({ item }: { item: Extract<Item, { kind: "approve" }> }) {
  return (
    <Request
      icon={<ShieldQuestionIcon />}
      title={
        <span>
          Allow <span className="font-mono">{item.tool}</span>?
        </span>
      }
      description={item.reason}
      answer={item.answer === "allow" ? "Allowed" : item.answer === "deny" ? "Denied" : item.answer}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => act("/api/answer", { id: item.id, value: "deny" })}>
            Deny
          </Button>
          <Button size="sm" onClick={() => act("/api/answer", { id: item.id, value: "allow" })}>
            Allow
          </Button>
        </>
      }
      footer={<pre className="max-h-60 w-full overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">{item.input}</pre>}
    />
  );
}

const HANDOFF_STATUS: Record<string, string> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  canceled: "bg-destructive/10 text-destructive",
};

/** `other`: the bot on the far side, when it still exists; the card takes its color. */
function HandoffCard({ item, other }: { item: Extract<Item, { kind: "handoff" }>; other: BotSummary | undefined }) {
  const received = item.direction === "received";
  return (
    <div style={other && botTheme(other.avatar.stroke)} className={cn("grid gap-2 rounded-xl border bg-card p-4 text-sm shadow-[0_0_24px_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_24px_1px_rgb(0_0_0/0.4)]", other && "bot-theme")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {received ? <ArrowDownLeftIcon className="size-3.5" /> : <ArrowUpRightIcon className="size-3.5" />}
        <span className="flex items-center gap-1">
          Handoff {received ? "from" : "to"}
          {other ? (
            <Link to="/bots/$botId" params={{ botId: other.id }} className="inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1 font-medium text-primary transition-colors hover:bg-primary/10">
              <BotAvatar avatar={other.avatar} className="size-4" />
              {item.bot}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{item.bot}</span>
          )}
        </span>
        <Badge variant="secondary" className={cn("ml-auto capitalize", HANDOFF_STATUS[item.status])}>
          {item.status}
        </Badge>
      </div>
      {item.title && <p className="font-medium">{item.title}</p>}
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{item.text}</div>
    </div>
  );
}
