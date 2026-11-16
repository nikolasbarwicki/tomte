import { existsSync, readFileSync } from "node:fs";

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SDKMessage,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent, TaskState } from "@claudebot/contract/events";

import { RECORD_PROGRESS, type ProgressAttribution } from "./agents.ts";
import type { ActivityType, Progress, SessionLog } from "./store.ts";
import { findingsOf, foldTasks, taskEvent, type Tasks } from "./tasks.ts";
import type { TaskView } from "./work-state.ts";

/** How long a finished task waits for its report text from the SubagentStop hook, which may arrive after the notification. */
export const REPORT_WAIT_MS = 5000;

export interface ObserverDeps {
  log: SessionLog;
  /** The session's queue: which queue entry an Agent call starts, and what a queue id became. */
  tasks: Tasks;
  attribution: ProgressAttribution;
  /** Tells the chat what the page shows: task snapshots, status lines and reports. */
  emit: (e: ServerEvent) => void;
  /** Called after a task started, resumed or ended, so the chat can move its presence line. */
  changed: () => void;
  /** Model and effort an agent type runs on when the Agent call names none. */
  defaults: (agentType: string | undefined) => { model: string; effort: string };
  now?: () => number;
  /** Runs `fn` after `ms` and returns what cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  logLine?: (line: string) => void;
}

interface Launch {
  agentType?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  description?: string | undefined;
  /** The queue entry the front was asked to start with this call. */
  queuedId?: string | undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const END_STATUS = {
  completed: "done",
  failed: "failed",
  stopped: "cancelled",
} as const satisfies Record<string, TaskState>;

/** Text of the last assistant message in a Claude Code transcript (JSONL), or "". */
export function lastAssistantText(path: string): string {
  if (!path || !existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type !== "assistant" || !Array.isArray(content)) continue;
    const text = content
      .flatMap((b: { type?: string; text?: string }) =>
        b.type === "text" && b.text ? [b.text] : [],
      )
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Turns the front session's SDK messages and hook calls into task rows, live status lines and reports, for one bot session. A
 * report is posted once: its text comes from the agent's SubagentStop hook or, failing that, from its transcript, and the hook
 * and the task notification may arrive in either order.
 */
export class Observer {
  /** One live line per running task. */
  private readonly statuses = new Map<string, string>();
  /** Agent tool calls by tool use id, until their task starts. */
  private readonly launches = new Map<string, Launch>();
  /** SendMessage calls by tool use id, until their result arrives. */
  private readonly steers = new Map<string, { taskId: string; text: string }>();
  /** Last message of each stopped agent, until its task notification arrives. */
  private readonly stopText = new Map<string, string>();
  /** Finished tasks whose report text has not arrived yet, with what cancels their wait. */
  private readonly awaitingReport = new Map<string, () => void>();
  /** Tasks whose current run has posted its report, so the signal that arrives second adds nothing. */
  private readonly reported = new Set<string>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly d: ObserverDeps) {
    this.now = d.now ?? Date.now;
    this.schedule =
      d.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  get hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const safe =
      (fn: HookCallback): HookCallback =>
      async (input, id, options) => {
        try {
          return await fn(input, id, options);
        } catch (err) {
          (this.d.logLine ?? console.error)(`[loop] hook failed: ${String(err)}`);
          return {};
        }
      };
    return {
      PreToolUse: [
        {
          hooks: [
            safe(async (input) =>
              input.hook_event_name === "PreToolUse" ? this.onToolUse(input) : {},
            ),
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            safe(async (input) =>
              input.hook_event_name === "SubagentStop" ? this.onSubagentStop(input) : {},
            ),
          ],
        },
      ],
    };
  }

  /** The session's tasks grouped as the work state lists them, with the status lines, findings and steers of those that run. */
  view(): TaskView {
    return foldTasks(this.d.log.tasks(), (t) => {
      const steers = this.d.log.events("steer", t.taskId);
      return {
        line: this.statuses.get(t.taskId),
        findings: findingsOf(this.d.log, t.taskId),
        steers:
          steers.filter((e) => e.state === "sent").length -
          steers.filter((e) => e.state === "failed").length,
      };
    });
  }

  /** How many agents run now; an interrupted one does not. */
  running(): number {
    return this.d.log.tasks().filter((t) => t.status === "running").length;
  }

  /** The live status lines, for a page that connects while tasks run. */
  statusEvents(): ServerEvent[] {
    return [...this.statuses].map(([taskId, text]) => ({ type: "task_status", taskId, text }));
  }

  /** The agents are gone with their CLI process: marks what still runs as interrupted and drops the status lines. */
  interruptRunning(): void {
    for (const t of this.d.log.tasks()) {
      if (t.status !== "running") continue;
      this.d.log.setStatus(t.taskId, "interrupted", this.now());
      this.clearStatus(t.taskId);
      this.emitTask(t.taskId);
    }
    this.d.changed();
  }

  /** A finding an agent recorded through `record_progress`, attributed to its task. */
  recordProgress(taskId: string, progress: Progress): void {
    this.d.log.append({ kind: "progress", taskId, at: this.now(), progress });
    if (progress.finding) this.emitTask(taskId);
  }

  /** Shows the page the task as the store has it now; `queuedId` says a queue entry became this task. */
  private emitTask(taskId: string, queuedId?: string) {
    const t = this.d.log.getTask(taskId);
    if (t)
      this.d.emit({
        ...taskEvent(t, findingsOf(this.d.log, taskId)),
        ...(queuedId && { queuedId }),
      });
  }

  private onToolUse(input: {
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    agent_id?: string | undefined;
  }) {
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const name = input.tool_name;
    if (input.agent_id) {
      const taskId = input.agent_id;
      if (name === RECORD_PROGRESS)
        this.d.attribution.note(input.tool_use_id, taskId, input.tool_input);
      else if (name === "WebSearch") this.activity(taskId, "search", str(args.query) ?? "");
      else if (name === "WebFetch") this.activity(taskId, "open", str(args.url) ?? "");
      else
        this.activity(
          taskId,
          "tool",
          `${name}: ${clip(str(args.command) ?? str(args.file_path) ?? str(args.pattern) ?? JSON.stringify(args), 300)}`,
        );
    } else if (name === "Agent")
      this.launches.set(input.tool_use_id, {
        agentType: str(args.subagent_type),
        model: str(args.model),
        effort: str(args.effort),
        description: str(args.description),
        queuedId: this.d.tasks.claim({
          name: str(args.name),
          description: str(args.description),
          prompt: str(args.prompt),
        }),
      });
    else if (name === "SendMessage") this.onSteer(input.tool_use_id, args);
    return {};
  }

  /** The front gave a running task an instruction: it is logged as sent now, and as failed if the tool answers with an error. */
  private onSteer(toolUseId: string, args: Record<string, unknown>) {
    const taskId = this.d.tasks.resolve(str(args.to) ?? "");
    if (!this.d.log.getTask(taskId)) return;
    const text = str(args.message) ?? JSON.stringify(args.message ?? "");
    this.steers.set(toolUseId, { taskId, text });
    this.d.log.append({ kind: "steer", taskId, at: this.now(), state: "sent", text });
  }

  private activity(taskId: string, type: ActivityType, text: string) {
    if (this.d.log.getTask(taskId))
      this.d.log.append({ kind: "activity", taskId, at: this.now(), type, text });
  }

  private onSubagentStop(input: SubagentStopHookInput) {
    const text =
      input.last_assistant_message?.trim() || lastAssistantText(input.agent_transcript_path);
    if (!text || this.reported.has(input.agent_id)) return {};
    const cancel = this.awaitingReport.get(input.agent_id);
    if (cancel) {
      cancel();
      this.awaitingReport.delete(input.agent_id);
      this.report(input.agent_id, text);
    } else this.stopText.set(input.agent_id, text);
    return {};
  }

  /** Posts a task's report: stored, then shown. The same text twice in a row for one task is posted once. */
  private report(taskId: string, text: string) {
    this.reported.add(taskId);
    if (this.d.log.events("report", taskId).at(-1)?.text === text) return;
    this.d.log.append({ kind: "report", taskId, at: this.now(), text });
    this.d.emit({ type: "report", taskId, text });
  }

  onMessage(m: SDKMessage): void {
    if (m.type === "user") this.onToolResults(m);
    if (m.type !== "system") return;
    if (m.subtype === "task_started") this.onTaskStarted(m);
    else if (m.subtype === "task_progress") {
      if (m.summary && this.statuses.has(m.task_id)) this.setStatus(m.task_id, m.summary);
    } else if (m.subtype === "task_notification") this.onTaskEnded(m);
  }

  /** A SendMessage the tool rejected, such as one to an agent that does not exist, is a failed steer. */
  private onToolResults(m: Extract<SDKMessage, { type: "user" }>) {
    if (m.parent_tool_use_id !== null || ("agent_id" in m && m.agent_id)) return;
    if (!Array.isArray(m.message.content)) return;
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const steer = this.steers.get(b.tool_use_id);
      if (!steer) continue;
      this.steers.delete(b.tool_use_id);
      if (!b.is_error) continue;
      const why =
        typeof b.content === "string"
          ? b.content
          : (b.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ");
      this.d.log.append({
        kind: "steer",
        taskId: steer.taskId,
        at: this.now(),
        state: "failed",
        text: `${steer.text} (rejected: ${clip(why.trim(), 300)})`,
      });
    }
  }

  private onTaskStarted(m: Extract<SDKMessage, { subtype: "task_started" }>) {
    if (
      (m.task_type && m.task_type !== "local_agent") ||
      m.parent_task_id ||
      m.skip_transcript ||
      m.ambient
    )
      return;
    const launch = m.tool_use_id ? this.launches.get(m.tool_use_id) : undefined;
    if (m.tool_use_id) this.launches.delete(m.tool_use_id);
    // The agent that was started for a queue entry replaces the entry.
    const queued = launch?.queuedId ? this.d.tasks.started(launch.queuedId, m.task_id) : undefined;
    const known = this.d.log.getTask(m.task_id);
    const agentType = launch?.agentType ?? m.subagent_type ?? known?.agentType ?? queued?.agentType;
    const defaults = this.d.defaults(agentType);
    const now = this.now();
    // A resumed agent is a new run of the same task: what the last run left unposted is stale.
    this.stopText.delete(m.task_id);
    this.reported.delete(m.task_id);
    this.awaitingReport.get(m.task_id)?.();
    this.awaitingReport.delete(m.task_id);
    this.d.log.putTask(
      {
        taskId: m.task_id,
        agentType,
        model: launch?.model ?? known?.model ?? defaults.model,
        effort: launch?.effort ?? known?.effort ?? defaults.effort,
        goal: known?.goal ?? queued?.goal ?? (launch?.description || m.description),
        status: "running",
        startedAt: known?.startedAt ?? now,
      },
      now,
    );
    this.emitTask(m.task_id, queued?.taskId);
    this.setStatus(m.task_id, known ? "Resuming" : "Starting");
    this.d.changed();
  }

  private onTaskEnded(m: Extract<SDKMessage, { subtype: "task_notification" }>) {
    const task = this.d.log.getTask(m.task_id);
    if (!task) return;
    // After a restart Claude Code reports each orphaned agent as stopped. The app has already marked it interrupted, and a
    // steer can still continue it, so it is not a cancel.
    const status: TaskState =
      m.reason === "worker_restart" || (m.status === "stopped" && task.status === "interrupted")
        ? "interrupted"
        : END_STATUS[m.status];
    if (task.status !== status) this.d.log.setStatus(m.task_id, status, this.now());
    this.clearStatus(m.task_id);
    this.emitTask(m.task_id);
    const text = this.stopText.get(m.task_id) || lastAssistantText(m.output_file);
    this.stopText.delete(m.task_id);
    if (status === "failed") {
      this.report(
        m.task_id,
        `This one failed${m.summary ? ` (${m.summary})` : ""}.${text ? ` Here is what it had before it broke:\n\n${text}` : " It left no output."}`,
      );
    } else if (
      status === "done" &&
      !this.reported.has(m.task_id) &&
      !this.awaitingReport.has(m.task_id)
    ) {
      if (text) this.report(m.task_id, text);
      else
        this.awaitingReport.set(
          m.task_id,
          this.schedule(() => {
            this.awaitingReport.delete(m.task_id);
            this.report(
              m.task_id,
              lastAssistantText(m.output_file) || "(The task finished without a report.)",
            );
          }, REPORT_WAIT_MS),
        );
    }
    this.d.changed();
  }

  private setStatus(taskId: string, text: string) {
    if (this.statuses.get(taskId) === text) return;
    this.statuses.set(taskId, text);
    this.d.emit({ type: "task_status", taskId, text });
  }

  private clearStatus(taskId: string) {
    if (this.statuses.delete(taskId)) this.d.emit({ type: "task_status", taskId, text: "" });
  }
}
