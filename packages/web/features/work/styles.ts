import type { FeatureStatus, WorkItemState } from "@tomte/contract/events";

/** How a source's derived status reads on its card and in its detail. */
export const STATUS: Record<FeatureStatus, { label: string; style: string }> = {
  needs_you: { label: "Needs you", style: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  blocked: { label: "Blocked", style: "bg-orange-500/10 text-orange-700 dark:text-orange-400" },
  failed: { label: "Failed", style: "bg-destructive/10 text-destructive" },
  running: { label: "Running", style: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  stopped: { label: "Stopped", style: "bg-muted text-muted-foreground" },
  done: { label: "Done", style: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
};

/** How an item's state reads as a chip. */
export const ITEM: Record<WorkItemState, { label: string; style: string }> = {
  queued: { label: "queued", style: "bg-muted text-muted-foreground" },
  running: { label: "running", style: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  review: { label: "in review", style: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  needs_you: { label: "needs you", style: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  done: { label: "done", style: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "failed", style: "bg-destructive/10 text-destructive" },
};
