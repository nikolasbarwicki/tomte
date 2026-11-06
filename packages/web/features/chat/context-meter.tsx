import type { ContextEvent } from "@claudebot/contract/events";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { kTokens } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

/** How full the session's context window is, after the Context pattern. */
export function ContextMeter({ context }: { context: ContextEvent | undefined }) {
  const pct = context?.percentage ?? 0;
  const high = pct >= 80;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn("tabular-nums", high ? "text-destructive" : "text-muted-foreground")}
          />
        }
      >
        {context ? `${pct}%` : "–"}
        <span className="hidden sm:inline">context</span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex flex-col gap-3">
        {context ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Context</span>
              <span className="text-muted-foreground tabular-nums">
                {kTokens(context.tokens)} / {kTokens(context.max)}
              </span>
            </div>
            <Progress
              value={pct}
              aria-label="Context used"
              className={cn(high && "**:data-[slot=progress-indicator]:bg-destructive")}
            />
            {high && <p className="text-muted-foreground">Consider a new session.</p>}
          </>
        ) : (
          <p className="text-muted-foreground">Context usage appears after the next reply.</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
