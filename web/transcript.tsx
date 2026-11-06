import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Streamdown } from "streamdown";
import {
  AlarmClockIcon,
  ArrowDownIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  ChevronRightIcon,
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
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { BotSummary, ServerEvent, WaitAction } from "./events.ts";
import { act } from "./api.ts";
import { botTheme } from "./avatars.ts";
import { BotAvatar } from "./bot-avatar.tsx";
import { kTokens } from "./format.ts";

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

/** The scrolling message list. It follows new output while the reader is at the bottom and stays put once they scroll up. */
export function Transcript({ bot, bots, items, busy, onShowBrowser }: { bot: BotSummary; bots: BotSummary[]; items: Item[]; busy: boolean; onShowBrowser: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const toBottom = (behavior: ScrollBehavior) => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior });

  useEffect(() => {
    if (atBottom) toBottom("instant");
  }, [items, busy]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="h-full overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {items.length === 0 && !busy ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>Message {bot.name}</EmptyTitle>
              <EmptyDescription>{bot.purpose || "Tell it what this bot is for and what to do first. It remembers how you like things done."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {items.map((it, i) => (
              <Row key={i} item={it} bots={bots} onShowBrowser={onShowBrowser} />
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="text-primary" /> {bot.name} is working…
              </div>
            )}
          </div>
        )}
      </div>
      {!atBottom && (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Jump to latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => toBottom("smooth")}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}

function Row({ item, bots, onShowBrowser }: { item: Item; bots: BotSummary[]; onShowBrowser: () => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm break-words whitespace-pre-wrap text-primary-foreground">
          {item.mentions?.map((m) => {
            const target = bots.find((b) => b.id === m.id);
            return target ? (
              <Link key={m.id} to="/bots/$botId" params={{ botId: target.id }} style={botTheme(target.avatar.stroke)} className="bot-theme mr-1 rounded-full bg-background px-1.5 font-semibold text-primary transition-colors hover:bg-secondary">
                @{m.name}
              </Link>
            ) : (
              <span key={m.id} className="mr-1 font-semibold">
                @{m.name}
              </span>
            );
          })}
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="bot-reply mr-auto max-w-[85%] min-w-0 rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm leading-relaxed">
          <Streamdown linkSafety={{ enabled: false }}>{item.text}</Streamdown>
        </div>
      );
    case "error":
      return (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription className="break-words whitespace-pre-wrap">{item.text}</AlertDescription>
        </Alert>
      );
    case "update":
      return (
        <Alert>
          <MegaphoneIcon />
          <AlertDescription className="text-foreground">{item.text}</AlertDescription>
        </Alert>
      );
    case "info":
      return <p className="text-center text-xs text-muted-foreground">{item.text}</p>;
    case "session":
      return (
        <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          New session · earlier messages are no longer in the bot's context
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "routine":
      return (
        <Badge variant="outline" className="mx-auto h-6 gap-1.5 px-2.5 text-muted-foreground">
          <AlarmClockIcon />
          Routine <span className="font-semibold text-foreground">{item.name}</span> · {item.trigger === "manual" ? "test run" : "scheduled"}
        </Badge>
      );
    case "handoff":
      return <HandoffCard item={item} other={bots.find((b) => b.id === item.botId)} />;
    case "tool":
      return <ToolCall name={item.name} input={item.input} />;
    case "wait":
      return <WaitCard item={item} onShowBrowser={onShowBrowser} />;
    case "ask":
      return <AskCard item={item} />;
    case "approve":
      return <ApproveCard item={item} />;
  }
}

function ToolCall({ name, input }: { name: string; input: string }) {
  return (
    <Collapsible className="-my-1.5">
      <CollapsibleTrigger className="group/tool flex max-w-full items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground">
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{name}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{input}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A question or request the bot is blocked on. Open ones stand out; settled ones fade to a record. */
function PendingCard({
  icon,
  title,
  open,
  tone = "attention",
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  open: boolean;
  tone?: "attention" | "info";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 rounded-xl border p-4 text-sm",
        !open && "bg-muted/40",
        open && tone === "attention" && "border-amber-500/40 bg-amber-500/5",
        open && tone === "info" && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex gap-2.5">
        <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", open ? (tone === "info" ? "text-primary" : "text-amber-600 dark:text-amber-400") : "text-muted-foreground")}>
          {icon}
        </span>
        <div className="grid min-w-0 flex-1 gap-1">{title}</div>
      </div>
      {children}
    </div>
  );
}

function Settled({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CircleCheckIcon className="size-3.5" /> {label}
    </p>
  );
}

function WaitCard({ item, onShowBrowser }: { item: Extract<Item, { kind: "wait" }>; onShowBrowser: () => void }) {
  const open = item.resolved === undefined;
  const takeover = item.waitKind === "takeover";
  return (
    <PendingCard
      open={open}
      tone={takeover ? "info" : "attention"}
      icon={takeover ? <HandIcon /> : <ShieldQuestionIcon />}
      title={
        <>
          <span className="font-medium">{item.title}</span>
          {item.detail && <span className="text-muted-foreground">{item.detail}</span>}
        </>
      }
    >
      {open ? (
        <div className="flex flex-wrap gap-2">
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
        </div>
      ) : (
        <Settled label={item.resolved ?? ""} />
      )}
    </PendingCard>
  );
}

function AskCard({ item }: { item: Extract<Item, { kind: "ask" }> }) {
  const [reply, setReply] = useState("");
  const open = item.answer === undefined;
  return (
    <PendingCard
      open={open}
      icon={<MessageCircleQuestionIcon />}
      title={
        <>
          <span className="text-xs font-medium text-muted-foreground">The bot asks</span>
          <span className="whitespace-pre-wrap">{item.question}</span>
        </>
      }
    >
      {open ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("/api/answer", { id: item.id, value: reply });
          }}
        >
          <Input autoFocus placeholder="Your answer" value={reply} onChange={(e) => setReply(e.target.value)} className="bg-background" />
          <Button type="submit" disabled={!reply.trim()}>
            Answer
          </Button>
        </form>
      ) : (
        <Settled label={item.answer ?? ""} />
      )}
    </PendingCard>
  );
}

function ApproveCard({ item }: { item: Extract<Item, { kind: "approve" }> }) {
  const open = item.answer === undefined;
  return (
    <PendingCard
      open={open}
      icon={<ShieldQuestionIcon />}
      title={
        <>
          <span className="font-medium">
            Allow <span className="font-mono">{item.tool}</span>?
          </span>
          {item.reason && <span className="text-muted-foreground">{item.reason}</span>}
        </>
      }
    >
      <pre className="max-h-60 overflow-auto rounded-lg bg-background/80 p-3 font-mono text-xs whitespace-pre-wrap ring-1 ring-border">{item.input}</pre>
      {open ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => act("/api/answer", { id: item.id, value: "allow" })}>
            Allow
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("/api/answer", { id: item.id, value: "deny" })}>
            Deny
          </Button>
        </div>
      ) : (
        <Settled label={item.answer === "allow" ? "Allowed" : item.answer === "deny" ? "Denied" : (item.answer ?? "")} />
      )}
    </PendingCard>
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
    <div style={other && botTheme(other.avatar.stroke)} className={cn("grid gap-2 rounded-xl border bg-card p-4 text-sm", other && "bot-theme")}>
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
