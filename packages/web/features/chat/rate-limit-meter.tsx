import { useState } from "react";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import type { RateLimit } from "@/host/state.ts";
import { dateTime } from "@/lib/format.ts";
import { untilReset } from "@/lib/usage-limits.ts";
import { cn } from "@/lib/utils";

import { rateLimitRows, type RateLimitRow } from "./rate-limits.ts";

const TONE = {
  allowed: "text-muted-foreground",
  allowed_warning: "text-amber-700 dark:text-amber-400",
  rejected: "text-destructive",
} as const;

/**
 * The subscription's rate limit windows beside the context meter. Parallel agents spend the 5-hour and weekly limits faster, so a
 * background-tasks bot shows the most pressing window and, on hover, every window with its reset. Nothing shows until the CLI reports one.
 */
export function RateLimitMeter({ limits }: { limits: Record<string, RateLimit> }) {
  const [top, ...others] = rateLimitRows(limits);
  if (!top) return null;
  const rows = [top, ...others];
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid="rate-limits"
            data-status={top.status}
            className={cn("tabular-nums", TONE[top.status])}
          />
        }
      >
        {top.percent === undefined
          ? top.status === "rejected"
            ? "limit reached"
            : "limit"
          : `${top.percent}%`}
        <span className="hidden sm:inline">{top.label}</span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex flex-col gap-3">
        {rows.map((row) => (
          <Window key={row.window} row={row} />
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

function Window({ row }: { row: RateLimitRow }) {
  // The card mounts when it opens, so this is the time the user looks at the reset.
  const [now] = useState(Date.now);
  return (
    <div className="flex flex-col gap-1.5" data-window={row.window}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{row.label}</span>
        <span className={cn("tabular-nums", TONE[row.status])}>
          {row.percent === undefined ? "" : `${row.percent}% used`}
        </span>
      </div>
      {row.percent !== undefined && (
        <Progress
          value={row.percent}
          aria-label={`${row.label} used`}
          className={cn(
            row.status === "rejected" && "**:data-[slot=progress-indicator]:bg-destructive",
          )}
        />
      )}
      {row.status === "rejected" && (
        <p className="text-destructive">Limit reached; agents wait until it resets.</p>
      )}
      {row.status === "allowed_warning" && (
        <p className="text-muted-foreground">Close to the limit.</p>
      )}
      {row.resetsAt !== undefined && (
        <p className="text-muted-foreground">
          Resets in {untilReset(row.resetsAt, now)} ({dateTime(row.resetsAt)})
        </p>
      )}
    </div>
  );
}
