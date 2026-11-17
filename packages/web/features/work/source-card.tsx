import type { WorkSource } from "@tomte/contract/events";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { ago, progressOf } from "./model.ts";
import { ITEM, STATUS } from "./styles.ts";

/** One event source: its status, step, progress and items, and when it was last heard from. Clicking it opens its detail. */
export function SourceCard({
  source,
  now,
  onOpen,
}: {
  source: WorkSource;
  now: number;
  onOpen: () => void;
}) {
  const { work } = source;
  const { done, total } = progressOf(work?.items ?? []);
  const status = STATUS[source.status];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full gap-2 rounded-lg border p-3 text-left outline-none focus-visible:ring-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium" title={source.label}>
            {source.label}
          </span>
          <Badge variant="secondary" className={status.style}>
            {status.label}
          </Badge>
        </div>
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{work?.step ?? "No work reported yet"}</span>
          <span className="shrink-0">{ago(source.lastEventAt, now)}</span>
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
        {work && total > 0 && (
          <ul className="flex flex-wrap gap-1">
            {work.items.map((item) => (
              <li
                key={item.id}
                title={`${item.label} · ${ITEM[item.state].label}`}
                className={cn(
                  "max-w-32 truncate rounded px-1.5 py-0.5 text-xs",
                  ITEM[item.state].style,
                )}
              >
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </button>
    </li>
  );
}
