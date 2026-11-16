/** Slots for agents running at once; the CLI enforces it through `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. */
export const MAX_PARALLEL = 3;

const RECENT_ENDED = 3;
/** Findings the work state lists for one running task, newest last. */
export const MAX_FINDINGS = 8;

/** One background task as the front sees it in the work state. */
export interface WorkTask {
  taskId: string;
  agentType?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  /** What the task was asked to do, in one line. */
  goal: string;
  /** When it started (epoch ms); ignored for queued and ended tasks. */
  since: number;
  /** `interrupted` marks a running task an app restart cut off. */
  status: string;
  /** For a queued task: the task it waits for, when it waits for one. */
  after?: string | null | undefined;
  /** For a running task: its live status line, from the agent's progress summaries. */
  line?: string | undefined;
  /** For a running task: what its agent verified so far, newest last. Listing it, even empty, is what says the agent reports findings. */
  findings?: readonly string[] | undefined;
  /** For a running task: instructions sent to it that it did not reject. */
  steers?: number | undefined;
}

/** Every task of one session, grouped by where it stands; `ended` is oldest first. */
export interface TaskView {
  running: readonly WorkTask[];
  queued: readonly WorkTask[];
  ended: readonly WorkTask[];
}

const NO_TASKS: TaskView = { running: [], queued: [], ended: [] };

const elapsed = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

/**
 * The block the app appends to every message the front receives; the user never sees it. It lists running, queued and recently
 * ended tasks with their ids, so the front takes task ids from the latest block and never from memory. A running task lists its
 * live status line, its findings and how many instructions it was sent.
 */
export function workState(
  view: TaskView = NO_TASKS,
  maxParallel = MAX_PARALLEL,
  now = Date.now(),
): string {
  const describe = (t: WorkTask) =>
    `${t.agentType ?? "agent"} ${t.model ?? "?"}/${t.effort ?? "?"}`;
  const lines = [
    "<work_state>",
    `running (${view.running.length} of ${maxParallel} slots):${view.running.length ? "" : " (none)"}`,
  ];
  for (const t of view.running) {
    lines.push(`  - id ${t.taskId} ${describe(t)}, ${elapsed(now - t.since)}: ${quote(t.goal)}`);
    if (t.status === "interrupted")
      lines.push("    interrupted by an app restart, not resumed yet");
    if (t.line) lines.push(`    status: ${quote(t.line)}`);
    if (t.findings?.length) {
      lines.push(`    findings (newest last, max ${MAX_FINDINGS}):`);
      for (const f of t.findings.slice(-MAX_FINDINGS))
        lines.push(`      - ${f.replace(/\s+/g, " ").trim()}`);
    } else if (t.findings) lines.push("    findings: (none yet)");
    if (t.steers) lines.push(`    instructions sent so far: ${t.steers}`);
  }
  lines.push(`queued:${view.queued.length ? "" : " (none)"}`);
  for (const t of view.queued)
    lines.push(
      `  - id ${t.taskId} ${t.agentType ?? "agent"}, ${t.after ? `after ${t.after}` : "when a slot frees"}: ${quote(t.goal)}`,
    );
  const recent = view.ended.slice(-RECENT_ENDED);
  lines.push(`recent (last ${RECENT_ENDED} ended):${recent.length ? "" : " (none)"}`);
  for (const t of recent) lines.push(`  - id ${t.taskId}, ${t.status}, ${quote(t.goal)}`);
  lines.push("</work_state>");
  return lines.join("\n");
}

/** The text of a front-session user message without the work state the app appended to it. */
export function withoutWorkState(text: string): string {
  const at = text.lastIndexOf("\n\n<work_state>\n");
  return at >= 0 && text.trimEnd().endsWith("\n</work_state>") ? text.slice(0, at) : text;
}
