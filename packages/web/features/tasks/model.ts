import type { Item } from "@/host/transcript.ts";

export type TaskRow = Extract<Item, { kind: "task" }>;

/** The tasks of the open double-loop chat as the Tasks tab lists them. */
export interface TaskGroups {
  /** Every task that holds a slot, oldest start first; an interrupted one (a host restart cut it off) is listed here too. */
  running: TaskRow[];
  /** In the order they were queued. */
  queued: TaskRow[];
  /** The latest ended tasks, newest end first. */
  recent: TaskRow[];
}

/** How many ended tasks the tab lists. */
export const RECENT_TASKS = 5;

const isTask = (i: Item): i is TaskRow => i.kind === "task";

export function groupTasks(items: readonly Item[]): TaskGroups {
  const tasks = items.filter(isTask);
  return {
    running: tasks
      .filter((t) => t.state === "running" || t.state === "interrupted")
      .sort((a, b) => a.startedAt - b.startedAt),
    queued: tasks.filter((t) => t.state === "queued"),
    recent: tasks
      .filter((t) => t.state === "done" || t.state === "failed" || t.state === "cancelled")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, RECENT_TASKS),
  };
}

/** What a queued task waits for: the goal of the task it follows, else a free slot. */
export function waitsFor(task: TaskRow, items: readonly Item[]): string {
  if (task.after === undefined) return "a free slot";
  const blocker = items.filter(isTask).find((t) => t.taskId === task.after);
  return blocker ? `“${blocker.goal}” to end` : "another task to end";
}
