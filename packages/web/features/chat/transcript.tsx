import { useState, useTransition } from "react";
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
  XIcon,
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
import type { BotSummary } from "@claudebot/contract/events";
import { answer, answerWait, cancelSend } from "./api.ts";
import { botTheme } from "@/lib/avatars.ts";
import { BotAvatar } from "@/components/bot-avatar.tsx";
import type { Item } from "@/host/transcript.ts";
import { bindMentions } from "./mentions.ts";

type ToolItem = Extract<Item, { kind: "tool" }>;
type QueuedItem = Extract<Item, { kind: "queued" }>;
/** What the thread renders: items as they came, except back-to-back tool calls collapse into one trace of steps. */
type Row = Exclude<Item, ToolItem | QueuedItem> | { kind: "steps"; tools: ToolItem[] };

/** Scroller items use `content-visibility: auto`, whose paint containment would clip a handoff card's shadow. */
const UNCLIPPED = "[content-visibility:visible]";

function toRows(items: Item[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (item.kind === "queued") continue;
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
  const queued = items.filter((i): i is QueuedItem => i.kind === "queued");
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
            {queued.map((q) => (
              <MessageScrollerItem key={q.id} messageId={`queued-${q.id}`}>
                <UserMessage text={q.text} mentions={q.mentions} bots={bots} queuedId={q.id} />
              </MessageScrollerItem>
            ))}
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
    case "user":
      return <UserMessage text={row.text} mentions={row.mentions} bots={bots} />;
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

/** A message from the user. `queuedId` marks one still waiting for the bot: it is dimmed and can be cancelled. */
function UserMessage({ text, mentions = [], bots, queuedId }: { text: string; mentions?: { id: string; name: string }[]; bots: BotSummary[]; queuedId?: string }) {
  const [canceling, startCancel] = useTransition();
  const bound = bindMentions(text, mentions);
  const leading = mentions.filter((m) => !bound.mentions.includes(m)).map((m) => ({ mention: m, text: `@${m.name}` }));
  return (
    <Message align="end">
      <MessageContent>
        <Bubble align="end" className={cn(queuedId && "opacity-60")}>
          <BubbleContent className="whitespace-pre-wrap">
            {[...leading.flatMap((s) => [s, " "]), ...bound.segments].map((s, i) => {
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
        {queuedId && (
          <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
            Queued · runs after the current turn
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={canceling}
              onClick={() =>
                startCancel(async () => {
                  await cancelSend(queuedId);
                })
              }
            >
              {canceling ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
              Cancel
            </Button>
          </div>
        )}
      </MessageContent>
    </Message>
  );
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

/** Pending state for the buttons of one request card: all are disabled while a command runs, and `pressed` names the one that started it. */
function useCardCommand() {
  const [pending, startTransition] = useTransition();
  const [pressed, setPressed] = useState<string>();
  const press = (key: string, command: () => Promise<unknown>) => {
    setPressed(key);
    startTransition(async () => {
      await command();
    });
  };
  return { pending, pressed, press };
}

function WaitCard({ item, onShowBrowser }: { item: Extract<Item, { kind: "wait" }>; onShowBrowser: () => void }) {
  const { pending, pressed, press } = useCardCommand();
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
            <Button key={a.id} size="sm" variant={i === 0 ? "default" : "outline"} disabled={pending} onClick={() => press(a.id, () => answerWait(item.id, a.id))}>
              {pending && pressed === a.id && <Spinner data-icon="inline-start" />}
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
  const [pending, start] = useTransition();
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
              start(async () => {
                await answer(item.id, reply);
              });
            }}
          >
            <Input autoFocus placeholder="Your answer" value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button type="submit" disabled={pending || !reply.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              Answer
            </Button>
          </form>
        )
      }
    />
  );
}

function ApproveCard({ item }: { item: Extract<Item, { kind: "approve" }> }) {
  const { pending, pressed, press } = useCardCommand();
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
          <Button size="sm" variant="outline" disabled={pending} onClick={() => press("deny", () => answer(item.id, "deny"))}>
            {pending && pressed === "deny" && <Spinner data-icon="inline-start" />}
            Deny
          </Button>
          <Button size="sm" disabled={pending} onClick={() => press("allow", () => answer(item.id, "allow"))}>
            {pending && pressed === "allow" && <Spinner data-icon="inline-start" />}
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
