import {
  AlarmIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  RobotIcon,
  WarningCircleIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  ProhibitIcon,
  GlobeIcon,
  HandIcon,
  QuestionIcon,
  ShieldWarningIcon,
  WrenchIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { Attachment, BotSummary, HandoffStatus, Presence } from "@tomte/contract/events";
import { useState, useTransition } from "react";
import { Streamdown } from "streamdown";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { RelayStatus } from "@/components/relay-status.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item as ItemRow,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { downloadUrl } from "@/host/api.ts";
import type { Item } from "@/host/transcript.ts";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

import { answer, answerWait, cancelSend } from "./api.ts";
import { EXTERNAL_ICONS } from "./external-icons.ts";
import { bindMentions } from "./mentions.ts";
import { approvalAnswerLabel, approvalButtons, cardElementId } from "./model.ts";
import { Scroller, ScrollerItem } from "./scroller.tsx";

type ToolItem = Extract<Item, { kind: "tool" }>;
type QueuedItem = Extract<Item, { kind: "queued" }>;
/** What the thread renders: items as they came, except back-to-back tool calls collapse into one trace of steps. */
type Row = Exclude<Item, ToolItem | QueuedItem> | { kind: "steps"; tools: ToolItem[] };

/** Scroller items use `content-visibility: auto`, whose paint containment would clip a handoff card's shadow. */
const UNCLIPPED = "[content-visibility:visible]";

const isRequest = (row: Row): row is Extract<Row, { kind: "wait" | "approve" | "ask" }> =>
  row.kind === "wait" || row.kind === "approve" || row.kind === "ask";

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

/** The thread. It follows the newest output while the reader is at the end, and jumps there when the user sends a message. */
export function Transcript({
  bot,
  bots,
  items,
  presence,
  onShowBrowser,
  onShowTasks,
}: {
  bot: BotSummary;
  bots: BotSummary[];
  items: Item[];
  /** What the one presence line says: `typing` while a double-loop bot writes a reply, `working` while a turn or agents run, nothing when idle. */
  presence: Presence;
  onShowBrowser: () => void;
  onShowTasks: () => void;
}) {
  const busy = presence !== "idle";
  if (items.length === 0 && !busy) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RobotIcon />
          </EmptyMedia>
          <EmptyTitle>Message {bot.name}</EmptyTitle>
          <EmptyDescription>
            {bot.purpose ||
              "Tell it what this bot is for and what to do first. It remembers how you like things done."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  // A double-loop chat shows only the conversation: its tasks live in the Tasks tab, and their results arrive as messages.
  const doubleLoop = bot.chatMode === "double_loop";
  const rows = toRows(doubleLoop ? items.filter((i) => i.kind !== "task") : items);
  const tasksRunning = doubleLoop
    ? items.filter((i) => i.kind === "task" && i.state === "running").length
    : 0;
  const queued = items.filter((i): i is QueuedItem => i.kind === "queued");
  // Queued and delivered messages together: a send adds one, delivering a queued message only moves it.
  const sent = items.filter((i) => i.kind === "user" || i.kind === "queued").length;
  return (
    <Scroller
      followKey={sent}
      busy={busy}
      className="flex-1"
      contentClassName="mx-auto w-full max-w-228 gap-4 px-4 py-6"
    >
      {rows.map((row, i) => (
        <ScrollerItem
          key={i}
          {...(isRequest(row) && { id: cardElementId(row.id) })}
          className={cn(row.kind === "handoff" && UNCLIPPED)}
        >
          <RowView
            row={row}
            botId={bot.id}
            running={busy && i === rows.length - 1}
            bots={bots}
            onShowBrowser={onShowBrowser}
          />
        </ScrollerItem>
      ))}
      {busy && (
        <ScrollerItem>
          <Marker role="status">
            <MarkerIcon>
              <Spinner className="text-primary" />
            </MarkerIcon>
            <MarkerContent className="shimmer">
              {bot.name} is {presence === "typing" ? "typing" : "working"}
              {presence === "working" && tasksRunning > 0
                ? ` on ${tasksRunning} ${tasksRunning === 1 ? "task" : "tasks"}`
                : ""}
              …
            </MarkerContent>
            {presence === "working" && tasksRunning > 0 && (
              <Button variant="link" size="xs" className="h-auto p-0" onClick={onShowTasks}>
                View tasks
              </Button>
            )}
          </Marker>
        </ScrollerItem>
      )}
      {queued.map((q) => (
        <ScrollerItem key={q.id}>
          <UserMessage
            text={q.text}
            mentions={q.mentions}
            attachments={q.attachments}
            bots={bots}
            queuedId={q.id}
          />
        </ScrollerItem>
      ))}
    </Scroller>
  );
}

/** `running`: the row is the live edge of a turn still in progress. */
function RowView({
  row,
  running,
  botId,
  bots,
  onShowBrowser,
}: {
  row: Row;
  running: boolean;
  botId: string;
  bots: BotSummary[];
  onShowBrowser: () => void;
}) {
  switch (row.kind) {
    case "user":
      return (
        <UserMessage
          text={row.text}
          mentions={row.mentions}
          attachments={row.attachments}
          bots={bots}
        />
      );
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
          <WarningCircleIcon />
          <AlertDescription className="break-words whitespace-pre-wrap">
            {row.text}
          </AlertDescription>
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
          <MarkerContent>
            New session · earlier messages are no longer in the bot's context
          </MarkerContent>
        </Marker>
      );
    case "routine":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerIcon>
            <AlarmIcon className="size-3.5" />
          </MarkerIcon>
          <MarkerContent>
            Routine <span className="text-foreground font-semibold">{row.name}</span> ·{" "}
            {row.trigger === "manual" ? "test run" : "scheduled"}
          </MarkerContent>
        </Marker>
      );
    case "external": {
      const Icon = EXTERNAL_ICONS[row.eventKind];
      return (
        <div className="grid gap-1">
          <Marker>
            <MarkerIcon>
              <Icon />
            </MarkerIcon>
            <MarkerContent className="truncate">
              <span className="text-foreground font-semibold">{row.source}</span> · {row.title}
            </MarkerContent>
            <span className="ml-auto shrink-0 text-xs">
              {row.state === "open" ? "in Needs you" : "handled"}
            </span>
          </Marker>
          {row.relay && (
            <p className="text-muted-foreground px-1 text-xs break-words">
              <RelayStatus botId={botId} id={row.id} relay={row.relay} />
            </p>
          )}
        </div>
      );
    }
    case "report":
      return <Report text={row.text} task={row.task} />;
    case "task":
      return <TaskLine item={row} />;
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
function UserMessage({
  text,
  mentions = [],
  attachments = [],
  bots,
  queuedId,
}: {
  text: string;
  mentions?: { id: string; name: string }[] | undefined;
  attachments?: Attachment[] | undefined;
  bots: BotSummary[];
  queuedId?: string;
}) {
  const [canceling, startCancel] = useTransition();
  const bound = bindMentions(text, mentions);
  const leading = mentions
    .filter((m) => !bound.mentions.includes(m))
    .map((m) => ({ mention: m, text: `@${m.name}` }));
  return (
    <Message align="end">
      <MessageContent>
        {attachments.length > 0 && (
          <ul className={cn("flex flex-wrap justify-end gap-1.5", queuedId && "opacity-60")}>
            {attachments.map((a) => {
              const name = a.path.slice(a.path.lastIndexOf("/") + 1);
              const chip =
                "border-border/70 bg-card text-foreground inline-flex h-8 max-w-64 items-center gap-1.5 rounded-lg border px-2.5 text-xs";
              return (
                <li key={a.path} className="min-w-0">
                  {a.folder ? (
                    <span className={chip} title={a.path}>
                      <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate">{name}</span>
                    </span>
                  ) : (
                    <a
                      href={downloadUrl(a.path)}
                      download
                      title={`Download ${a.path}`}
                      className={cn(chip, "hover:bg-muted transition-colors")}
                    >
                      <FileIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate">{name}</span>
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {text && (
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
                    style={botTheme(target.avatar.color)}
                    className="bot-theme bg-background text-primary hover:bg-secondary inline-flex items-baseline gap-1 rounded-full px-1.5 font-semibold transition-colors"
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
        )}
        {queuedId && (
          <div className="text-muted-foreground flex items-center justify-end gap-1 text-xs">
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
              {canceling ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <XIcon data-icon="inline-start" />
              )}
              Cancel
            </Button>
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

/** A report is the bot's own message, written by a background task; hovering it names the task. */
function Report({ text, task }: { text: string; task: string | undefined }) {
  const message = (
    <Message>
      <MessageContent>
        <Bubble variant="muted" className="max-w-[60%]">
          <BubbleContent className="w-full">
            <Streamdown linkSafety={{ enabled: false }}>{text}</Streamdown>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
  if (task === undefined) return message;
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>{message}</TooltipTrigger>
      <TooltipContent>Result of the task: {task}</TooltipContent>
    </Tooltip>
  );
}

/** One line for a background task: its goal and where it stands, with the live status line while it runs. */
function TaskLine({ item }: { item: Extract<Item, { kind: "task" }> }) {
  const running = item.state === "running";
  const [icon, label] = {
    queued: [<ProhibitIcon key="i" />, "Queued"],
    running: [<Spinner key="i" className="text-primary" />, "Working on"],
    interrupted: [<ProhibitIcon key="i" />, "Interrupted"],
    done: [<CheckCircleIcon key="i" />, "Done"],
    failed: [<WarningCircleIcon key="i" />, "Failed"],
    cancelled: [<ProhibitIcon key="i" />, "Stopped"],
  }[item.state];
  return (
    <Marker role={running ? "status" : undefined}>
      <MarkerIcon>{icon}</MarkerIcon>
      <MarkerContent className={cn("truncate", running && "shimmer")}>
        {label}: <span className="text-foreground font-semibold">{item.goal}</span>
        {running && item.status && <> · {item.status}</>}
      </MarkerContent>
    </Marker>
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
            <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">
              {tool.input}
            </pre>
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
  expired,
  actions,
  footer,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  answer: string | undefined;
  /** Nobody is waiting for an answer any more. */
  expired?: boolean | undefined;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const open = answer === undefined && !expired;
  return (
    <ItemRow variant={open ? "outline" : "muted"} size="sm">
      <ItemMedia variant="icon" className={cn(open && "text-primary")}>
        {icon}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">{title}</ItemTitle>
        {description && (
          <ItemDescription className="line-clamp-none whitespace-pre-wrap">
            {description}
          </ItemDescription>
        )}
      </ItemContent>
      {open ? (
        actions && <ItemActions className="flex-wrap">{actions}</ItemActions>
      ) : (
        <ItemActions className="text-muted-foreground text-xs">
          {expired && answer === undefined ? (
            <>
              <ProhibitIcon className="size-3.5" /> No longer waiting: its turn ended
            </>
          ) : (
            <>
              <CheckCircleIcon className="size-3.5" /> {answer}
            </>
          )}
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

function WaitCard({
  item,
  onShowBrowser,
}: {
  item: Extract<Item, { kind: "wait" }>;
  onShowBrowser: () => void;
}) {
  const { pending, pressed, press } = useCardCommand();
  const takeover = item.waitKind === "takeover";
  return (
    <Request
      icon={takeover ? <HandIcon /> : <ShieldWarningIcon />}
      title={item.title}
      description={item.detail}
      answer={item.resolved}
      actions={
        <>
          {item.actions.map((a, i) => (
            <Button
              key={a.id}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              disabled={pending}
              onClick={() => press(a.id, () => answerWait(item.id, a.id))}
            >
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
  const { pending, pressed, press } = useCardCommand();
  const form = (
    <form
      className="flex w-full gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        press("answer", () => answer(item.id, reply));
      }}
    >
      <Input
        autoFocus={!item.options?.length}
        placeholder="Your answer"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
      />
      <Button type="submit" disabled={pending || !reply.trim()}>
        {pending && pressed === "answer" && <Spinner data-icon="inline-start" />}
        Answer
      </Button>
    </form>
  );
  return (
    <Request
      icon={<QuestionIcon />}
      title="The bot asks"
      description={item.question}
      answer={item.answer}
      expired={item.expired}
      footer={
        item.answer === undefined &&
        !item.expired &&
        (item.options?.length ? (
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {item.options.map((option, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => press(`option-${i}`, () => answer(item.id, option))}
                >
                  {pending && pressed === `option-${i}` && <Spinner data-icon="inline-start" />}
                  {option}
                </Button>
              ))}
            </div>
            {form}
          </div>
        ) : (
          form
        ))
      }
    />
  );
}

function ApproveCard({ item }: { item: Extract<Item, { kind: "approve" }> }) {
  const { pending, pressed, press } = useCardCommand();
  const [note, setNote] = useState("");
  const open = item.answer === undefined;
  return (
    <Request
      icon={<ShieldWarningIcon />}
      title={
        <span>
          Allow <span className="font-mono">{item.tool}</span>?
        </span>
      }
      description={item.reason}
      answer={item.answer === undefined ? undefined : approvalAnswerLabel(item.answer)}
      actions={approvalButtons(item.actions).map((a) => (
        <Button
          key={a.id}
          size="sm"
          variant={a.main ? "default" : "outline"}
          disabled={pending}
          onClick={() =>
            press(a.id, () => (a.takesNote ? answer(item.id, a.id, note) : answer(item.id, a.id)))
          }
        >
          {pending && pressed === a.id && <Spinner data-icon="inline-start" />}
          {a.label}
        </Button>
      ))}
      footer={
        <div className="flex w-full flex-col gap-2">
          {open && (
            <Input
              aria-label="Note for the bot if you deny"
              placeholder="Note for the bot if you deny (optional)"
              maxLength={500}
              value={note}
              disabled={pending}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <pre className="bg-muted/60 max-h-60 w-full overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {item.input}
          </pre>
        </div>
      }
    />
  );
}

const HANDOFF_STATUS: Partial<Record<HandoffStatus, string>> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  canceled: "bg-destructive/10 text-destructive",
};

/** `other`: the bot on the far side, when it still exists; the card takes its color. */
function HandoffCard({
  item,
  other,
}: {
  item: Extract<Item, { kind: "handoff" }>;
  other: BotSummary | undefined;
}) {
  const received = item.direction === "received";
  return (
    <div
      style={other && botTheme(other.avatar.color)}
      className={cn(
        "grid gap-2 rounded-xl border bg-card p-4 text-sm shadow-[0_0_24px_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_24px_1px_rgb(0_0_0/0.4)]",
        other && "bot-theme",
      )}
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {received ? (
          <ArrowDownLeftIcon className="size-3.5" />
        ) : (
          <ArrowUpRightIcon className="size-3.5" />
        )}
        <span className="flex items-center gap-1">
          Handoff {received ? "from" : "to"}
          {other ? (
            <Link
              to="/bots/$botId"
              params={{ botId: other.id }}
              className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1 font-medium transition-colors"
            >
              <BotAvatar avatar={other.avatar} className="size-4" />
              {item.bot}
            </Link>
          ) : (
            <span className="text-foreground font-medium">{item.bot}</span>
          )}
        </span>
        <Badge
          variant="secondary"
          className={cn("ml-auto capitalize", HANDOFF_STATUS[item.status])}
        >
          {item.status}
        </Badge>
      </div>
      {item.title && <p className="font-medium">{item.title}</p>}
      <div className="text-muted-foreground max-h-48 overflow-y-auto whitespace-pre-wrap">
        {item.text}
      </div>
    </div>
  );
}
