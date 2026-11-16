import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "@claudebot/contract/events";

import { migrate } from "../platform/db.ts";
import { ProgressAttribution } from "./agents.ts";
import { Observer, REPORT_WAIT_MS, lastAssistantText } from "./observe.ts";
import { createLoopStore, type SessionLog } from "./store.ts";

let log: SessionLog;
let attribution: ProgressAttribution;
let observer: Observer;
let emitted: ServerEvent[];
let changed: number;
let clock: number;
/** The waits the observer scheduled, which a test runs by hand instead of waiting. */
let waits: { fn: () => void; ms: number; cancelled: boolean }[];

beforeEach(() => {
  log = createLoopStore(migrate(new Database(":memory:"))).session("bot", "session");
  attribution = new ProgressAttribution();
  emitted = [];
  changed = 0;
  clock = 1000;
  waits = [];
  observer = new Observer({
    log,
    attribution,
    emit: (e) => emitted.push(e),
    changed: () => changed++,
    defaults: () => ({ model: "sonnet", effort: "medium" }),
    now: () => clock,
    schedule: (fn, ms) => {
      const wait = { fn, ms, cancelled: false };
      waits.push(wait);
      return () => {
        wait.cancelled = true;
      };
    },
    logLine: () => {},
  });
});

const system = (subtype: string, fields: Record<string, unknown>) =>
  ({ type: "system", subtype, ...fields }) as unknown as SDKMessage;
const started = (taskId = "t1", extra: Record<string, unknown> = {}) =>
  observer.onMessage(
    system("task_started", { task_id: taskId, description: "research X", ...extra }),
  );
const progress = (summary: string, taskId = "t1") =>
  observer.onMessage(system("task_progress", { task_id: taskId, summary }));
const ended = (status: string, extra: Record<string, unknown> = {}, taskId = "t1") =>
  observer.onMessage(
    system("task_notification", {
      task_id: taskId,
      status,
      output_file: "",
      summary: "",
      ...extra,
    }),
  );

async function hook(name: "PreToolUse" | "SubagentStop", input: Record<string, unknown>) {
  const callback = observer.hooks[name]?.[0]?.hooks[0] as HookCallback;
  await callback({ hook_event_name: name, ...input } as never, undefined, {
    signal: new AbortController().signal,
  });
}
const stopped = (text: string, agentId = "t1") =>
  hook("SubagentStop", {
    agent_id: agentId,
    agent_type: "researcher",
    agent_transcript_path: "",
    last_assistant_message: text,
  });
const reports = () => emitted.filter((e) => e.type === "report");
const types = () => emitted.map((e) => e.type);

describe("a task starting", () => {
  test("is stored as running with the Agent call's goal, model and effort and shown with a Starting status", async () => {
    await hook("PreToolUse", {
      tool_name: "Agent",
      tool_use_id: "tu-1",
      tool_input: {
        subagent_type: "researcher",
        description: "pricing of X",
        model: "opus",
        effort: "high",
      },
    });
    started("t1", { tool_use_id: "tu-1", description: "ignored" });

    expect(log.getTask("t1")).toMatchObject({
      agentType: "researcher",
      goal: "pricing of X",
      model: "opus",
      effort: "high",
      status: "running",
      startedAt: 1000,
    });
    expect(emitted).toMatchObject([
      { type: "task", taskId: "t1", state: "running", goal: "pricing of X" },
      { type: "task_status", taskId: "t1", text: "Starting" },
    ]);
    expect(changed).toBe(1);
    expect(observer.running()).toBe(1);
  });

  test("without an Agent call takes the message's description and the agent type's defaults", () => {
    started("t1", { subagent_type: "researcher" });

    expect(log.getTask("t1")).toMatchObject({
      goal: "research X",
      agentType: "researcher",
      model: "sonnet",
      effort: "medium",
    });
  });

  test("is skipped for work that is not a top-level background agent", () => {
    started("a", { task_type: "local_workflow" });
    started("b", { parent_task_id: "t1" });
    started("c", { skip_transcript: true });
    started("d", { ambient: true });

    expect(log.tasks()).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("a second start of a known task resumes it: same goal and start, a Resuming status, and its report can post again", async () => {
    started();
    await stopped("first report");
    ended("completed");
    clock = 2000;
    started("t1", { description: "something else" });

    expect(log.getTask("t1")).toMatchObject({
      goal: "research X",
      startedAt: 1000,
      status: "running",
    });
    expect(log.getTask("t1")?.endedAt).toBeUndefined();
    expect(emitted.at(-1)).toEqual({ type: "task_status", taskId: "t1", text: "Resuming" });

    await stopped("second report");
    ended("completed");
    expect(reports().map((r) => r.text)).toEqual(["first report", "second report"]);
  });
});

describe("status lines", () => {
  test("follow progress summaries, once per change, for running tasks only", () => {
    started();
    emitted.length = 0;
    progress("Searching");
    progress("Searching");
    progress("Reading");
    progress("Ignored", "unknown");
    progress("");

    expect(emitted).toEqual([
      { type: "task_status", taskId: "t1", text: "Searching" },
      { type: "task_status", taskId: "t1", text: "Reading" },
    ]);
    expect(observer.statusEvents()).toEqual([
      { type: "task_status", taskId: "t1", text: "Reading" },
    ]);
  });

  test("clear when the task ends", () => {
    started();
    progress("Reading");
    emitted.length = 0;
    ended("stopped");

    expect(emitted).toMatchObject([
      { type: "task_status", taskId: "t1", text: "" },
      { type: "task", state: "cancelled" },
    ]);
    expect(observer.statusEvents()).toEqual([]);
  });
});

describe("what an agent does", () => {
  test("is stored as activity for a known task: searches, opened pages and other tools", async () => {
    started();
    const call = (tool_name: string, tool_input: unknown) =>
      hook("PreToolUse", { tool_name, tool_input, tool_use_id: tool_name, agent_id: "t1" });
    await call("WebSearch", { query: "x pricing" });
    await call("WebFetch", { url: "https://x.test" });
    await call("Bash", { command: "ls" });
    await call("Read", { file_path: "/tmp/a" });
    await call("Odd", { a: 1 });
    await hook("PreToolUse", {
      tool_name: "WebSearch",
      tool_input: { query: "no" },
      tool_use_id: "z",
      agent_id: "ghost",
    });

    expect(log.events("activity").map((e) => [e.type, e.text])).toEqual([
      ["search", "x pricing"],
      ["open", "https://x.test"],
      ["tool", "Bash: ls"],
      ["tool", "Read: /tmp/a"],
      ["tool", 'Odd: {"a":1}'],
    ]);
  });

  test("a record_progress call is noted for its agent, and recordProgress stores the finding on the task", async () => {
    started();
    const finding = { phase: "p", finding: "f", next: "n" };
    await hook("PreToolUse", {
      tool_name: "mcp__loop__record_progress",
      tool_input: finding,
      tool_use_id: "tu-rp",
      agent_id: "t1",
    });
    expect(attribution.take("tu-rp", finding)).toBe("t1");

    observer.recordProgress("t1", finding);
    expect(log.events("progress")).toEqual([
      { kind: "progress", taskId: "t1", at: 1000, progress: finding },
    ]);
  });
});

describe("a task's report", () => {
  test("posts once when the hook arrives before the notification, and again signals add nothing", async () => {
    started();
    await stopped("The answer.");
    expect(reports()).toEqual([]);
    ended("completed");
    await stopped("The answer.");
    ended("completed");

    expect(reports()).toEqual([{ type: "report", taskId: "t1", text: "The answer." }]);
    expect(log.events("report")).toHaveLength(1);
    expect(log.getTask("t1")?.status).toBe("done");
    expect(waits).toEqual([]);
  });

  test("posts once when the notification arrives first and the hook follows within the wait", async () => {
    started();
    ended("completed");
    expect(reports()).toEqual([]);
    expect(waits).toMatchObject([{ ms: REPORT_WAIT_MS, cancelled: false }]);

    await stopped("The answer.");
    expect(reports()).toEqual([{ type: "report", taskId: "t1", text: "The answer." }]);
    expect(waits[0]?.cancelled).toBe(true);
    // The cancelled wait is gone: a later signal adds nothing.
    await stopped("The answer.");
    expect(log.events("report")).toHaveLength(1);
  });

  test("a notification repeated while the report is awaited starts no second wait", async () => {
    started();
    ended("completed");
    ended("completed");
    expect(waits).toHaveLength(1);

    await stopped("The answer.");
    expect(log.events("report")).toHaveLength(1);
    expect(waits.every((w) => w.cancelled)).toBe(true);
  });

  test("posts a placeholder when the wait runs out with no text anywhere", () => {
    started();
    ended("completed");
    waits[0]?.fn();

    expect(reports()).toEqual([
      { type: "report", taskId: "t1", text: "(The task finished without a report.)" },
    ]);
  });

  test("falls back to the agent's transcript when the hook gives no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "observe-"));
    try {
      const file = join(dir, "agent.jsonl");
      writeFileSync(
        file,
        [
          { type: "assistant", message: { content: [{ type: "text", text: "Earlier." }] } },
          "not json",
          { type: "assistant", message: { content: [{ type: "tool_use", id: "x" }] } },
          { type: "assistant", message: { content: [{ type: "text", text: "From the file." }] } },
        ]
          .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
          .join("\n"),
      );
      expect(lastAssistantText(file)).toBe("From the file.");
      expect(lastAssistantText(join(dir, "missing.jsonl"))).toBe("");
      expect(lastAssistantText("")).toBe("");

      started();
      ended("completed", { output_file: file });
      expect(reports()).toEqual([{ type: "report", taskId: "t1", text: "From the file." }]);
      expect(waits).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same text twice in a row is stored once, even across a resume", async () => {
    started();
    await stopped("Same.");
    ended("completed");
    started();
    await stopped("Same.");
    ended("completed");

    expect(log.events("report")).toHaveLength(1);
  });

  test("of a failed task says so with the reason and what it had", async () => {
    started();
    await stopped("Half an answer.");
    ended("failed", { summary: "out of turns" });

    expect(log.getTask("t1")?.status).toBe("failed");
    expect(reports()).toEqual([
      {
        type: "report",
        taskId: "t1",
        text: "This one failed (out of turns). Here is what it had before it broke:\n\nHalf an answer.",
      },
    ]);
  });

  test("of a failed task with no output says it left none", () => {
    started();
    ended("failed");

    expect(reports()[0]).toMatchObject({ text: "This one failed. It left no output." });
  });

  test("is not posted for a stopped task", async () => {
    started();
    await stopped("Partial.");
    ended("stopped");

    expect(log.getTask("t1")?.status).toBe("cancelled");
    expect(reports()).toEqual([]);
    expect(waits).toEqual([]);
  });

  test("is not posted for a task the app never saw start, and a start leaves no stale text for it", async () => {
    ended("completed", {}, "ghost");
    expect(emitted).toEqual([]);

    await stopped("Left over.");
    started();
    ended("completed");
    // The earlier run's stop text belongs to the earlier run: the new run waits for its own.
    expect(waits).toHaveLength(1);
  });
});

describe("a restart", () => {
  test("interruptRunning marks what runs as interrupted, drops the status lines and tells the page", () => {
    started("a");
    started("b");
    ended("stopped", {}, "b");
    emitted.length = 0;
    changed = 0;
    clock = 5000;
    observer.interruptRunning();

    expect(log.getTask("a")).toMatchObject({ status: "interrupted", updatedAt: 5000 });
    expect(log.getTask("b")?.status).toBe("cancelled");
    expect(types()).toEqual(["task_status", "task"]);
    expect(observer.statusEvents()).toEqual([]);
    expect(observer.running()).toBe(0);
    expect(changed).toBe(1);
  });

  test("an orphaned agent's stopped notification keeps its task interrupted, as does a worker restart", () => {
    started("a");
    started("b");
    observer.interruptRunning();
    ended("stopped", {}, "a");
    started("c");
    ended("stopped", { reason: "worker_restart" }, "c");

    expect(log.getTask("a")?.status).toBe("interrupted");
    expect(log.getTask("c")?.status).toBe("interrupted");
    expect(reports()).toEqual([]);
  });
});

describe("view", () => {
  test("groups tasks as running (interrupted included), queued and ended oldest end first", () => {
    log.putTask({ taskId: "q", goal: "queued", status: "queued", startedAt: 1 }, 1);
    started("r");
    started("i");
    observer.interruptRunning();
    started("late");
    started("early");
    clock = 3000;
    ended("completed", {}, "late");
    clock = 2000;
    ended("failed", {}, "early");

    const view = observer.view();
    expect(view.queued.map((t) => t.taskId)).toEqual(["q"]);
    expect(view.running.map((t) => t.taskId).sort()).toEqual(["i", "r"]);
    expect(view.ended.map((t) => t.taskId)).toEqual(["early", "late"]);
    expect(observer.running()).toBe(0);
  });
});

describe("hooks", () => {
  test("a hook that throws is logged and answers nothing, so the agent is not held up", async () => {
    const lines: string[] = [];
    const failing = new ProgressAttribution();
    failing.note = () => {
      throw new Error("disk full");
    };
    const broken = new Observer({
      log,
      attribution: failing,
      emit: () => {},
      changed: () => {},
      defaults: () => ({ model: "m", effort: "e" }),
      logLine: (l) => lines.push(l),
    });
    const callback = broken.hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const result = await callback(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__loop__record_progress",
        tool_input: {},
        tool_use_id: "x",
        agent_id: "t1",
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({});
    expect(lines).toEqual(["[loop] hook failed: Error: disk full"]);
  });

  test("ignore hook events of another kind", async () => {
    const pre = observer.hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const signal = new AbortController().signal;
    expect(await pre({ hook_event_name: "SubagentStop" } as never, undefined, { signal })).toEqual(
      {},
    );
    const stop = observer.hooks.SubagentStop?.[0]?.hooks[0] as HookCallback;
    expect(await stop({ hook_event_name: "PreToolUse" } as never, undefined, { signal })).toEqual(
      {},
    );
  });
});
