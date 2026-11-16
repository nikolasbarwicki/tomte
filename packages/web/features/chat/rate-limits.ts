import type { ServerEvent } from "@claudebot/contract/events";

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

const LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_overage_included: "Weekly limit",
  overage: "Extra usage",
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
        label: LABELS[window] ?? (window ? window.replaceAll("_", " ") : "Usage limit"),
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

/** How long until `resetsAt`, as "2h 5m", "45m" or "3d 4h"; "now" once it has passed. */
export function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
