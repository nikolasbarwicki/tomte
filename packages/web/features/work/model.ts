import type { FeatureStatus, SourceEvent, WorkItem, WorkSource } from "@tomte/contract/events";

const URGENCY: Record<FeatureStatus, number> = {
  needs_you: 0,
  blocked: 1,
  failed: 2,
  running: 3,
  stopped: 4,
  done: 5,
};

/** Sources the user should look at first come first; within one status, the one heard from most recently. */
export const sortSources = (sources: WorkSource[]): WorkSource[] =>
  [...sources].sort(
    (a, b) => URGENCY[a.status] - URGENCY[b.status] || b.lastEventAt - a.lastEventAt,
  );

/** How many of a source's items are done, and how many it has. */
export const progressOf = (items: WorkItem[]) => ({
  done: items.filter((i) => i.state === "done").length,
  total: items.length,
});

/** How long ago something happened, to the largest whole unit: "just now", "5m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** An item group in the order the source listed it; `group` is `undefined` for items with none. */
export type ItemGroup = { group: string | undefined; items: WorkItem[] };

/** Items clustered by `group`, groups in the order each first appears and items in their own order. */
export function groupItems(items: WorkItem[]): ItemGroup[] {
  const groups = new Map<string | undefined, WorkItem[]>();
  for (const item of items) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  return [...groups].map(([group, list]) => ({ group, items: list }));
}

/** Whether the source has an event that still waits for the user; the host refuses to archive such a source. */
export const hasOpenItems = (source: WorkSource): boolean =>
  source.events.some((e) => e.state === "open");

/** A source's events, newest first, as the timeline lists them. */
export const timelineOf = (events: SourceEvent[]): SourceEvent[] => [...events].reverse();

/** The chat message of a button on a whole source. */
export const sourceMessage = (verb: "Status" | "Focus" | "Pause", source: WorkSource): string =>
  `${verb} ${source.label}`;

/** The chat message of a button on one item, for example "Retry export-csv t04". */
export const itemMessage = (
  verb: "Status" | "Retry" | "Skip",
  source: WorkSource,
  item: WorkItem,
): string => `${verb} ${source.label} ${item.id}`;
