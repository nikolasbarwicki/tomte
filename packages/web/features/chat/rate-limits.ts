import type { ServerEvent } from "@tomte/contract/events";

import { usageLimitLabel } from "@/lib/usage-limits.ts";

type RateLimit = Extract<ServerEvent, { type: "rate_limit" }>;

export type RateLimitRow = {
  window: string;
  label: string;
  /** Percent of the window used, 0 to 100; absent when the CLI reported none. */
  percent: number | undefined;
  status: RateLimit["status"];
  /** When the window resets, in epoch milliseconds. */
  resetsAt: number | undefined;
};

const SEVERITY: Record<RateLimit["status"], number> = {
  allowed: 0,
  allowed_warning: 1,
  rejected: 2,
};

/** The rate limit windows the host reported, the most pressing first: a rejected window, then a warned one, then the most used. */
export function rateLimitRows(limits: Record<string, RateLimit>): RateLimitRow[] {
  return Object.values(limits)
    .map((l): RateLimitRow => {
      const window = l.window ?? "";
      return {
        window,
        label: usageLimitLabel(window),
        percent:
          l.utilization === undefined
            ? undefined
            : Math.min(100, Math.max(0, Math.round(l.utilization * 100))),
        status: l.status,
        resetsAt: l.resetsAt,
      };
    })
    .sort(
      (a, b) => SEVERITY[b.status] - SEVERITY[a.status] || (b.percent ?? -1) - (a.percent ?? -1),
    );
}
