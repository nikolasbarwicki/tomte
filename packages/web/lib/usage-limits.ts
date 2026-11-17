/** What the Claude subscription's usage windows are called, by the CLI's key; shared by the chat's rate limit meter and Settings, Models. */
const LABELS: Record<string, string> = {
  five_hour: "Session limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_oauth_apps: "Weekly apps limit",
  seven_day_overage_included: "Weekly limit",
  overage: "Extra usage",
};

/** A usage window's name; one the app does not know is shown by the CLI's own key. */
export const usageLimitLabel = (window: string) =>
  LABELS[window] ?? (window ? window.replaceAll("_", " ") : "Usage limit");

/** How long until `resetsAt`, as "2h 5m", "45m" or "3d 4h"; "now" once it has passed. */
export function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
