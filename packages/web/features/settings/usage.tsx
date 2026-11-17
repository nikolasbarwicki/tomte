import type { ClaudeUsage, UsageWindow } from "@tomte/contract/api";
import { useEffect, useRef, useState } from "react";

import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { dateTime } from "@/lib/format.ts";
import { untilReset, usageLimitLabel } from "@/lib/usage-limits.ts";
import { cn } from "@/lib/utils";

import { loadClaudeUsage } from "./api.ts";

/** How often the page asks again while it is shown, so the bars follow the bots' work. */
const USAGE_POLL_MS = 60_000;

/** At or above this share used a window is close to its limit. */
const WARN_AT = 80;

type Tone = "normal" | "warning" | "full";

const toneOf = (percent: number | null): Tone =>
  percent === null || percent < WARN_AT ? "normal" : percent >= 100 ? "full" : "warning";

const TEXT: Record<Tone, string> = {
  normal: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
  full: "text-destructive",
};

const BAR: Record<Tone, string> = {
  normal: "",
  warning: "**:data-[slot=progress-indicator]:bg-amber-500",
  full: "**:data-[slot=progress-indicator]:bg-destructive",
};

/**
 * The Claude subscription's session and weekly limits as bars, asked of the host when the page opens, on every refresh of it
 * (`revision` changes) and each minute while the tab is visible. Bots on a double-loop chat spend them fastest.
 */
export function PlanUsage({ revision }: { revision: unknown }) {
  const [usage, setUsage] = useState<ClaudeUsage>();
  const [error, setError] = useState<string>();
  const asked = useRef(0);

  useEffect(() => {
    const ask = async () => {
      const n = ++asked.current;
      try {
        const u = await loadClaudeUsage();
        if (n !== asked.current) return;
        setUsage(u);
        setError(undefined);
      } catch (e) {
        if (n === asked.current) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void ask();
    const timer = setInterval(() => document.hidden || void ask(), USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [revision]);

  if (usage && !usage.available)
    return (
      <p className="text-muted-foreground border-t pt-3 text-xs">
        Session and weekly limits don't apply to this sign-in.
      </p>
    );

  return (
    <section aria-labelledby="plan-usage" className="flex flex-col gap-3 border-t pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="plan-usage" className="text-xs font-medium">
          Plan usage
        </h3>
        {usage && (
          <span className="text-muted-foreground text-xs tabular-nums">
            Updated{" "}
            {new Date(usage.checkedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
      {!usage && !error && (
        <div aria-busy="true" aria-label="Checking usage" className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      )}
      {usage && usage.windows.length === 0 && (
        <p className="text-muted-foreground text-xs">Claude reported no limits for this plan.</p>
      )}
      {usage && usage.windows.length > 0 && (
        <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {usage.windows.map((w) => (
            <Window key={`${w.window}:${w.name ?? ""}`} window={w} now={usage.checkedAt} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Window({ window: w, now }: { window: UsageWindow; now: number }) {
  const label = w.name ? `Weekly ${w.name} limit` : usageLimitLabel(w.window);
  const tone = toneOf(w.percent);
  const percent = w.percent === null ? null : Math.round(w.percent);
  return (
    <li className="flex flex-col gap-1.5" data-window={w.window}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn("text-xs tabular-nums", TEXT[tone])}>
          {percent === null
            ? "Not reported"
            : tone === "full"
              ? "Limit reached"
              : `${percent}% used`}
        </span>
      </div>
      <Progress value={percent ?? 0} aria-label={`${label} used`} className={BAR[tone]} />
      {w.resetsAt !== null && (
        <p className="text-muted-foreground text-xs tabular-nums">
          Resets in {untilReset(w.resetsAt, now)} · {dateTime(w.resetsAt)}
        </p>
      )}
    </li>
  );
}
