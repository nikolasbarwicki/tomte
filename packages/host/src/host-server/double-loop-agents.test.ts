import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBot, setChatMode } from "../bots/index.ts";
import { createLoopStore } from "../loop/index.ts";
import { defined } from "../testing/defined.ts";
import { writeSession } from "../testing/session-file.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "double-loop-agents-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost(["--data-root", join(scratch, "state")]);
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type Streamed = { type: string; [k: string]: unknown };

async function doubleLoopBot() {
  const id = host.createBot("Dev");
  setChatMode(host.dataRoot, id, "double_loop");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

const send = async (text: string) => {
  const res = await host.ui("/api/send", { text });
  expect(res.status).toBe(200);
};

/** What a page connecting now is sent. */
async function pageEvents(): Promise<Streamed[]> {
  const watch = await watchEvents(host);
  // The snapshot of a double-loop bot ends with its presence.
  await host.until(() => watch.events().some((e) => e.type === "presence"));
  watch.stop();
  return watch.events();
}

const usage = { input_tokens: 1, output_tokens: 1 };
/** The front's assistant message that calls a tool. */
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  emit: {
    type: "assistant",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      usage,
    },
    parent_tool_use_id: null,
  },
});
const AGENT_CALL = {
  subagent_type: "researcher",
  description: "research X",
  prompt: "Find out about X.",
  run_in_background: true,
};
const FINDING = { phase: "Pricing", finding: "X costs $20 a month.", next: "Check the team plan." };
const REPORT = "X costs $20 a month on every plan.";
const QUEUE_ARGS = { goal: "compare plans", agent: "researcher", after: "agent-1" };

/** The scripted run: the front starts a researcher, which reports progress and finishes once the test lets it. */
const researchScript = {
  match: "research X",
  steps: [
    { text: "On it, looking into X." },
    toolUse("tu-agent", "Agent", AGENT_CALL),
    {
      hook: "PreToolUse",
      tool_use_id: "tu-agent",
      input: { tool_name: "Agent", tool_input: AGENT_CALL, tool_use_id: "tu-agent" },
    },
    {
      emit: {
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "tu-agent",
        description: "research X",
        subagent_type: "researcher",
      },
    },
    { result: "On it, looking into X." },
    {
      emit: {
        type: "system",
        subtype: "task_progress",
        task_id: "agent-1",
        description: "research X",
        summary: "Searching pricing pages",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      },
    },
    {
      hook: "PreToolUse",
      tool_use_id: "tu-rp",
      input: {
        tool_name: "mcp__loop__record_progress",
        tool_input: FINDING,
        tool_use_id: "tu-rp",
        agent_id: "agent-1",
      },
    },
    { mcp: { server: "loop", tool: "record_progress", args: FINDING } },
    {
      emit: {
        type: "system",
        subtype: "task_progress",
        task_id: "agent-1",
        description: "research X",
        summary: "Reading the team plan",
        usage: { total_tokens: 2, tool_uses: 2, duration_ms: 2 },
      },
    },
    { waitFor: "finish" },
    {
      hook: "SubagentStop",
      input: {
        agent_id: "agent-1",
        agent_type: "researcher",
        agent_transcript_path: "",
        stop_hook_active: false,
        last_assistant_message: REPORT,
      },
    },
    {
      emit: {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        status: "completed",
        output_file: "",
        summary: "done",
      },
    },
    // Both signals again, as a CLI that repeats itself would send them.
    {
      hook: "SubagentStop",
      input: {
        agent_id: "agent-1",
        agent_type: "researcher",
        agent_transcript_path: "",
        stop_hook_active: false,
        last_assistant_message: REPORT,
      },
    },
    { text: "That's the research done." },
    { result: "That's the research done." },
  ],
};

const reportsIn = (events: Streamed[]) => events.filter((e) => e.type === "report");
const taskStates = (events: Streamed[]) =>
  events.filter((e) => e.type === "task").map((e) => e.state);

describe("a double-loop bot's researcher", () => {
  test("research starts a task, moves its status line, attributes findings and posts one report", async () => {
    const bot = await doubleLoopBot();
    const watch = await watchEvents(host);
    host.loopScript(researchScript);
    await send("research X");

    // The task the front's Agent call started; the call itself is not shown, the chat holds only what was said.
    await host.until(() => taskStates(watch.events()).includes("running"));
    expect(watch.events().some((e) => e.type === "tool")).toBe(false);
    // The front's reply arrives whole, not word by word.
    expect(
      watch
        .events()
        .filter((e) => e.type === "delta")
        .map((e) => e.text),
    ).toEqual(["On it, looking into X."]);
    // The call runs on what the bot is set to, which the hook writes into it.
    expect(
      host.hookResults().find((h) => h.hook === "PreToolUse" && h.input.tool_name === "Agent")
        ?.response,
    ).toMatchObject({
      hookSpecificOutput: { updatedInput: { ...AGENT_CALL, model: "sonnet", effort: "medium" } },
    });
    expect(watch.events().find((e) => e.type === "task")).toMatchObject({
      taskId: "agent-1",
      agentType: "researcher",
      goal: "research X",
      model: "sonnet",
      effort: "medium",
    });

    // The status line follows the agent's progress summaries, and is not part of the history.
    const statuses = () =>
      watch
        .events()
        .filter((e) => e.type === "task_status")
        .map((e) => e.text);
    await host.until(() => statuses().includes("Reading the team plan"));
    expect(statuses()).toEqual(["Starting", "Searching pricing pages", "Reading the team plan"]);

    // record_progress reached the store attributed to the task through the PreToolUse hook.
    const log = createLoopStore(host.db).session(bot, bot);
    expect(log.events("progress")).toMatchObject([{ taskId: "agent-1", progress: FINDING }]);
    expect(host.loopCalls().at(-1)).toMatchObject({
      server: "loop",
      tool: "record_progress",
      result: { content: [{ text: "Recorded. Continue the task." }] },
    });
    expect(host.hookResults().filter((h) => h.callback === null)).toEqual([]);

    // While the agent runs the bot is working, though the front has answered.
    await host.until(() => {
      const events = watch.events();
      return events.filter((e) => e.type === "presence").at(-1)?.state === "working";
    });
    const busy = await pageEvents();
    expect(busy.find((e) => e.type === "presence")?.state).toBe("working");
    expect(busy.filter((e) => e.type === "task_status").map((e) => e.text)).toEqual([
      "Reading the team plan",
    ]);
    const bots = busy.find((e) => e.type === "bots") as unknown as {
      bots: { id: string; status: string }[];
    };
    expect(bots.bots.find((b) => b.id === bot)?.status).toBe("working");

    host.allow("finish");
    await host.until(() => reportsIn(watch.events()).length >= 1);
    await host.until(() => watch.events().filter((e) => e.type === "done").length >= 2);
    watch.stop();

    // One report even though the hook and the notification each came twice.
    const events = watch.events();
    expect(reportsIn(events)).toEqual([
      { type: "report", taskId: "agent-1", text: REPORT, at: expect.any(Number) },
    ]);
    expect(log.events("report")).toMatchObject([
      { taskId: "agent-1", text: REPORT, at: expect.any(Number) },
    ]);
    expect(taskStates(events).at(-1)).toBe("done");
    expect(events.filter((e) => e.type === "task_status").at(-1)).toMatchObject({
      taskId: "agent-1",
      text: "",
    });
    expect(events.filter((e) => e.type === "presence").at(-1)?.state).toBe("idle");
    // The report is not in the front's own session: only the user's message and the scripted ones reached the CLI.
    expect(host.messagesOf(bot)).toHaveLength(1);
  });

  test("a model and effort picked while the chat is open are saved and reach the next task, without a line in the chat", async () => {
    const bot = await doubleLoopBot();
    const watch = await watchEvents(host);
    expect((await host.ui("/api/model", { model: "opus" })).status).toBe(200);
    expect((await host.ui("/api/effort", { effort: "high" })).status).toBe(200);
    expect(getBot(host.dataRoot, bot)).toMatchObject({ model: "opus", effort: "high" });

    host.loopScript(researchScript);
    await send("research X");
    await host.until(() => taskStates(watch.events()).includes("running"));
    expect(
      host.hookResults().find((h) => h.hook === "PreToolUse" && h.input.tool_name === "Agent")
        ?.response,
    ).toMatchObject({ hookSpecificOutput: { updatedInput: { model: "opus", effort: "high" } } });
    expect(watch.events().find((e) => e.type === "task")).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(watch.events().some((e) => e.type === "info")).toBe(false);
    watch.stop();
  });

  test("the front opens as the front agent with every agent's tools in the session and three agent slots", async () => {
    const bot = await doubleLoopBot();
    host.loopScript({ steps: [] });
    await send("hello");
    await host.until(() => host.messagesOf(bot).length === 1);

    const launch = defined(host.launches()[0], "launch");
    expect(launch.argv.join(" ")).toMatch(/--agent[= ]front/);
    expect(launch.argv).toContain(
      "--tools=Agent,SendMessage,TaskStop,WebSearch,WebFetch,Read,Write,Edit,NotebookEdit,Glob,Grep,Bash",
    );
    expect(launch.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("3");
    expect(launch.appendSystemPrompt).toContain('subagent_type "researcher"');
  });

  test("a reloaded transcript shows the report once, between the messages written before and after it", async () => {
    const bot = await doubleLoopBot();
    host.loopScript(researchScript);
    await send("research X");
    await host.until(() => host.loopCalls().length === 1);
    host.allow("finish");
    const log = createLoopStore(host.db).session(bot, bot);
    await host.until(() => log.events("report").length === 1);
    await host.until(() => log.getTask("agent-1")?.status === "done");
    const at = defined(log.events("report")[0], "report").at;

    // The fake CLI writes no session file, so the file the real one would have written, around the report's time.
    writeSession(host, bot, [
      { role: "user", text: "research X\n\n<work_state>\n</work_state>", at: at - 2000 },
      { role: "assistant", text: "On it, looking into X.", at: at - 1500 },
      { role: "assistant", text: "That's the research done.", at: at + 1000 },
    ]);
    await host.restart();

    const events = await pageEvents();
    const shown = events
      .filter((e) => ["user", "delta", "task", "report"].includes(e.type))
      .map((e) =>
        e.type === "task" ? `task: ${String(e.state)}` : `${e.type}: ${String(e.text)}`,
      );
    expect(shown).toEqual([
      "user: research X",
      "delta: On it, looking into X.",
      "task: done",
      `report: ${REPORT}`,
      "delta: That's the research done.",
    ]);
    expect(events.find((e) => e.type === "task")).toMatchObject({
      taskId: "agent-1",
      state: "done",
      goal: "research X",
      findings: [FINDING.finding],
    });
    expect(events.some((e) => e.type === "task_status")).toBe(false);
  });

  test("a host that goes down with an agent running marks the task interrupted and does not block a mode switch", async () => {
    const bot = await doubleLoopBot();
    host.loopScript(researchScript);
    await send("research X");
    const log = createLoopStore(host.db).session(bot, bot);
    await host.until(() => log.events("progress").length === 1);
    expect(createLoopStore(host.db).hasActive(bot)).toBe(true);

    await host.restart();

    // The reopened chat tells its front about the cut-off agent; this front (no script) leaves it interrupted, and its turn ends.
    await host.until(() =>
      host.messageRecords(bot).some((m) => m.text.startsWith("The app restarted")),
    );
    expect(log.getTask("agent-1")?.status).toBe("interrupted");
    expect(createLoopStore(host.db).hasActive(bot)).toBe(false);
    const watch = await watchEvents(host);
    await host.until(
      () =>
        watch
          .events()
          .filter((e) => e.type === "presence")
          .at(-1)?.state === "idle",
    );
    watch.stop();
    expect(watch.events().filter((e) => e.type === "report")).toEqual([]);
  });
});

const agentCall = (description: string) => ({
  subagent_type: "researcher",
  description,
  prompt: `Find out: ${description}`,
  run_in_background: true,
});
const preToolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  hook: "PreToolUse",
  tool_use_id: id,
  input: { tool_name: name, tool_input: input, tool_use_id: id },
});
const taskStarted = (taskId: string, toolUseId: string, description: string) => ({
  emit: {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: "researcher",
  },
});
const toolResult = (id: string, content: string, isError = false) => ({
  emit: {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  },
});
/** The front starts a researcher for a message; `after` is what the agent does once it is running. */
const startsAgent = (
  match: string,
  toolUseId: string,
  taskId: string,
  description: string,
  after: Record<string, unknown>[] = [],
) => ({
  match,
  steps: [
    { text: "On it." },
    toolUse(toolUseId, "Agent", agentCall(description)),
    preToolUse(toolUseId, "Agent", agentCall(description)),
    taskStarted(taskId, toolUseId, description),
    { result: "On it." },
    ...after,
  ],
});

/** What the scripted front does for each of the five things the user says, and what agent 1 does meanwhile. */
const parallelScripts = [
  startsAgent("research ALPHA", "tu-a", "agent-1", "research ALPHA", [
    {
      hook: "PreToolUse",
      tool_use_id: "tu-rp",
      input: {
        tool_name: "mcp__loop__record_progress",
        tool_input: FINDING,
        tool_use_id: "tu-rp",
        agent_id: "agent-1",
      },
    },
    { mcp: { server: "loop", tool: "record_progress", args: FINDING } },
    { waitFor: "end-alpha" },
    {
      hook: "SubagentStop",
      input: {
        agent_id: "agent-1",
        agent_type: "researcher",
        agent_transcript_path: "",
        stop_hook_active: false,
        last_assistant_message: REPORT,
      },
    },
    {
      emit: {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        status: "completed",
        output_file: "",
        summary: "done",
      },
    },
  ]),
  startsAgent("research BETA", "tu-b", "agent-2", "research BETA"),
  {
    match: "focus ALPHA",
    steps: [
      { text: "Passing that on." },
      toolUse("tu-s1", "SendMessage", { to: "agent-1", message: "Focus on pricing." }),
      preToolUse("tu-s1", "SendMessage", { to: "agent-1", message: "Focus on pricing." }),
      toolResult("tu-s1", "Message queued for delivery"),
      toolUse("tu-s2", "SendMessage", { to: "agent-1", message: "And the team plan." }),
      preToolUse("tu-s2", "SendMessage", { to: "agent-1", message: "And the team plan." }),
      toolResult("tu-s2", "Agent agent-1 is busy", true),
      { result: "Passing that on." },
    ],
  },
  {
    match: "drop BETA",
    steps: [
      { text: "Dropping it now." },
      toolUse("tu-stop", "TaskStop", { task_id: "agent-2" }),
      preToolUse("tu-stop", "TaskStop", { task_id: "agent-2" }),
      {
        emit: {
          type: "system",
          subtype: "task_notification",
          task_id: "agent-2",
          status: "stopped",
          output_file: "",
          summary: "Stopped",
        },
      },
      { result: "Dropping it now." },
    ],
  },
  {
    match: "after ALPHA ends",
    steps: [
      { text: "Okay, I'll do that after the first one." },
      toolUse("tu-q", "mcp__loop__queue_task", QUEUE_ARGS),
      { mcp: { server: "loop", tool: "queue_task", args: QUEUE_ARGS } },
      { result: "Okay, I'll do that after the first one." },
    ],
  },
  {
    match: "Start queued task",
    steps: [
      toolUse("tu-c", "Agent", {
        ...agentCall("compare plans"),
        name: "{queued}",
      }),
      preToolUse("tu-c", "Agent", { ...agentCall("compare plans"), name: "{queued}" }),
      taskStarted("agent-3", "tu-c", "compare plans"),
      { result: "" },
    ],
  },
];

describe("a double-loop bot's parallel tasks", () => {
  test("two tasks run in parallel, one is steered and one cancelled, and a queued task is started by the front when its blocker ends", async () => {
    const bot = await doubleLoopBot();
    const watch = await watchEvents(host);
    host.loopScript(...parallelScripts);
    const log = createLoopStore(host.db).session(bot, bot);
    const records = () => host.messageRecords(bot);

    await send("research ALPHA");
    await send("research BETA");
    await host.until(() => log.getTask("agent-2")?.status === "running");
    expect(log.tasks().map((t) => [t.taskId, t.status])).toEqual([
      ["agent-1", "running"],
      ["agent-2", "running"],
    ]);
    await host.until(() => log.events("progress").length === 1);

    // A steer: sent, and a second one the tool rejected is failed too.
    await send("focus ALPHA on pricing");
    await host.until(() => log.events("steer").length === 3);
    expect(log.events("steer").map((e) => [e.taskId, e.state, e.text])).toEqual([
      ["agent-1", "sent", "Focus on pricing."],
      ["agent-1", "sent", "And the team plan."],
      ["agent-1", "failed", "And the team plan. (rejected: Agent agent-1 is busy)"],
    ]);

    // The message after it tells the front what the agent found and how many instructions it has been sent.
    await send("drop BETA");
    await host.until(() => log.getTask("agent-2")?.status === "cancelled");
    const state = defined(records().at(-1), "last message").text;
    expect(state).toContain("  - id agent-1 researcher sonnet/medium");
    expect(state).toContain("    findings (newest last, max 8):\n      - X costs $20 a month.");
    expect(state).toContain("    instructions sent so far: 1");
    expect(state).toContain("  - id agent-2 researcher sonnet/medium");
    expect(
      watch
        .events()
        .filter((e) => e.type === "task" && e.taskId === "agent-2")
        .map((e) => e.state),
    ).toEqual(["running", "cancelled"]);
    expect(reportsIn(watch.events())).toEqual([]);

    // Queued after the first task, it waits and nothing is asked of the front.
    await send("do the comparison after ALPHA ends");
    await host.until(() => log.tasks().some((t) => t.status === "queued"));
    const queued = defined(
      log.tasks().find((t) => t.status === "queued"),
      "queued task",
    );
    expect(queued).toMatchObject({
      goal: "compare plans",
      agentType: "researcher",
      after: "agent-1",
    });
    expect(host.loopCalls().at(-1)?.result?.content[0]?.text).toBe(`Queued as ${queued.taskId}.`);
    expect(createLoopStore(host.db).hasActive(bot)).toBe(true);
    expect(records().some((m) => m.text.startsWith("Start queued task"))).toBe(false);
    expect(
      watch.events().find((e) => e.type === "task" && e.taskId === queued.taskId),
    ).toMatchObject({ state: "queued", after: "agent-1", goal: "compare plans" });

    // The blocker ends: its report is posted, and the front is asked to start the queued task, as a message the app wrote.
    host.allow("end-alpha");
    await host.until(() => records().some((m) => m.text.startsWith("Start queued task")));
    const dispatch = defined(
      records().find((m) => m.text.startsWith("Start queued task")),
      "dispatch",
    );
    expect(dispatch).toMatchObject({ isSynthetic: true, priority: "next" });
    expect(dispatch.text).toStartWith(
      `Start queued task ${queued.taskId} (agent: researcher): compare plans`,
    );
    expect(reportsIn(watch.events())).toEqual([
      { type: "report", taskId: "agent-1", text: REPORT, at: expect.any(Number) },
    ]);

    // The front's Agent call names the queue id: the agent replaces the entry.
    await host.until(() => log.getTask("agent-3")?.status === "running");
    expect(log.getTask(queued.taskId)).toBeUndefined();
    expect(log.getTask("agent-3")).toMatchObject({
      goal: "compare plans",
      agentType: "researcher",
      status: "running",
    });
    const started = watch.events().find((e) => e.type === "task" && e.taskId === "agent-3");
    expect(started).toMatchObject({ state: "running", queuedId: queued.taskId });
    expect(records().filter((m) => m.text.startsWith("Start queued task"))).toHaveLength(1);
    watch.stop();

    // A page connecting now is replayed the events of the live thread; each task event replaces the one before, and a task that replaced a queue entry replaces its row.
    const events = await pageEvents();
    const rows = new Map<string, Streamed>();
    for (const e of events.filter((e) => e.type === "task")) {
      if (typeof e.queuedId === "string") rows.delete(e.queuedId);
      rows.set(String(e.taskId), e);
    }
    expect([...rows.values()].map((e) => [e.taskId, e.state, e.findings ?? null])).toEqual([
      ["agent-1", "done", [FINDING.finding]],
      ["agent-2", "cancelled", null],
      ["agent-3", "running", null],
    ]);
    expect(events.find((e) => e.type === "presence")?.state).toBe("working");
  });
});
