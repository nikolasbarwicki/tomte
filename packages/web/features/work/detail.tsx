import type { SourceEvent, WorkItem, WorkSource } from "@tomte/contract/events";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  HandIcon,
  InfoIcon,
  MessageCircleQuestionIcon,
  OctagonXIcon,
  type LucideIcon,
} from "lucide-react";

import { RelayStatus } from "@/components/relay-status.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { sendMessage } from "@/host/api.ts";
import { cn } from "@/lib/utils";

import { archiveSource } from "./api.ts";
import {
  ago,
  groupItems,
  hasOpenItems,
  itemMessage,
  progressOf,
  sourceMessage,
  timelineOf,
} from "./model.ts";
import { ITEM, STATUS } from "./styles.ts";

/** A button's message goes to the bot as the user's own chat message, so it shows in the transcript. */
const tell = (text: string) => void sendMessage(text, []);

const EVENT_ICONS: Record<SourceEvent["kind"], LucideIcon> = {
  question: MessageCircleQuestionIcon,
  blocked: HandIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  stopped: OctagonXIcon,
  progress: ActivityIcon,
  notice: InfoIcon,
};

const EVENT_STATE: Record<SourceEvent["state"], string | undefined> = {
  open: "needs you",
  acted: "handled",
  dismissed: "dismissed",
  resolved: "resolved",
  info: undefined,
};

/** One source inside the panel: its step and progress, buttons that message the bot, items by group and the timeline of its events. */
export function SourceDetail({
  botId,
  source,
  now,
  onBack,
}: {
  botId: string;
  source: WorkSource;
  now: number;
  onBack: () => void;
}) {
  const { work } = source;
  const { done, total } = progressOf(work?.items ?? []);
  const status = STATUS[source.status];
  const open = hasOpenItems(source);
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back to all work" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-sm font-medium" title={source.label}>
              {source.label}
            </h3>
            <Badge variant="secondary" className={status.style}>
              {status.label}
            </Badge>
          </div>
          <p className="text-muted-foreground flex justify-between gap-2 text-xs">
            <span className="truncate">{work?.step ?? "No work reported yet"}</span>
            <span className="shrink-0">{ago(source.lastEventAt, now)}</span>
          </p>
        </div>
      </div>
      {total > 0 && (
        <div className="flex items-center gap-2">
          <Progress
            value={(done / total) * 100}
            aria-label={`${done} of ${total} done`}
            className="flex-1"
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {done}/{total}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(["Status", "Focus", "Pause"] as const).map((verb) => (
          <Button
            key={verb}
            variant="outline"
            size="sm"
            onClick={() => tell(sourceMessage(verb, source))}
          >
            {verb}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={open}
          title={open ? "Act on or dismiss its open items first" : undefined}
          onClick={() => void archiveSource(botId, source.id)}
        >
          <ArchiveIcon /> Archive
        </Button>
      </div>
      {work && work.items.length > 0 && (
        <section className="grid gap-3">
          {groupItems(work.items).map(({ group, items }) => (
            <div key={group ?? ""} className="grid gap-1">
              {group !== undefined && (
                <h4 className="text-muted-foreground text-xs font-medium">{group}</h4>
              )}
              <ul className="grid gap-1">
                {items.map((item) => (
                  <ItemRow key={item.id} source={source} item={item} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      <section className="grid gap-2">
        <h4 className="text-muted-foreground text-xs font-medium">Timeline</h4>
        <ol className="grid gap-2">
          {timelineOf(source.events).map((e) => (
            <TimelineRow key={e.id} botId={botId} event={e} now={now} />
          ))}
        </ol>
      </section>
    </div>
  );
}

/** An item that expands to its summary and the buttons that message the bot about it. */
function ItemRow({ source, item }: { source: WorkSource; item: WorkItem }) {
  const state = ITEM[item.state];
  return (
    <li className="rounded-lg border">
      <Collapsible className="group">
        <CollapsibleTrigger className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm outline-none focus-visible:ring-3">
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[open]:rotate-90" />
          <span className="min-w-0 flex-1 truncate" title={item.label}>
            {item.label}
          </span>
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-xs", state.style)}>
            {state.label}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-2 px-2 pb-2 pl-8">
            <p className="text-muted-foreground text-xs whitespace-pre-wrap">
              {item.summary ?? "No summary yet."}
            </p>
            <div className="flex flex-wrap gap-2">
              {(["Status", "Retry", "Skip"] as const).map((verb) => (
                <Button
                  key={verb}
                  variant="outline"
                  size="xs"
                  onClick={() => tell(itemMessage(verb, source, item))}
                >
                  {verb}
                </Button>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function TimelineRow({ botId, event, now }: { botId: string; event: SourceEvent; now: number }) {
  const Icon = EVENT_ICONS[event.kind];
  const state = EVENT_STATE[event.state];
  return (
    <li className="flex gap-2 text-xs">
      <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex justify-between gap-2">
          <span className="font-medium break-words">{event.title}</span>
          <span className="text-muted-foreground shrink-0">
            {state && `${state} · `}
            {ago(event.receivedAt, now)}
          </span>
        </div>
        {event.body && (
          <p className="text-muted-foreground line-clamp-4 whitespace-pre-wrap">{event.body}</p>
        )}
        {event.relay && (
          <p className="text-muted-foreground break-words">
            <RelayStatus botId={botId} id={event.id} relay={event.relay} />
          </p>
        )}
      </div>
    </li>
  );
}
