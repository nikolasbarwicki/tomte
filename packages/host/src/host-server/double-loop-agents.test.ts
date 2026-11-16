import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setChatMode } from "../bots/index.ts";
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

    // The front's Agent call and the task it started.
    await host.until(() => taskStates(watch.events()).includes("running"));
    expect(watch.events().some((e) => e.type === "tool" && e.name === "Agent")).toBe(true);
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
    expect(reportsIn(events)).toEqual([{ type: "report", taskId: "agent-1", text: REPORT }]);
    expect(log.events("report")).toMatchObject([{ taskId: "agent-1", text: REPORT }]);
    expect(taskStates(events).at(-1)).toBe("done");
    expect(events.filter((e) => e.type === "task_status").at(-1)).toMatchObject({
      taskId: "agent-1",
      text: "",
    });
    expect(events.filter((e) => e.type === "presence").at(-1)?.state).toBe("idle");
    // The report is not in the front's own session: only the user's message and the scripted ones reached the CLI.
    expect(host.messagesOf(bot)).toHaveLength(1);
  });

  test("the front opens as the front agent with every agent's tools in the session and three agent slots", async () => {
    const bot = await doubleLoopBot();
    host.loopScript({ steps: [] });
    await send("hello");
    await host.until(() => host.messagesOf(bot).length === 1);

    const launch = defined(host.launches()[0], "launch");
    expect(launch.argv.join(" ")).toMatch(/--agent[= ]front/);
    expect(launch.argv).toContain("--tools=Agent,SendMessage,TaskStop,WebSearch,WebFetch");
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

    expect(log.getTask("agent-1")?.status).toBe("interrupted");
    expect(createLoopStore(host.db).hasActive(bot)).toBe(false);
    const events = await pageEvents();
    expect(events.find((e) => e.type === "presence")?.state).toBe("idle");
    expect(events.filter((e) => e.type === "report")).toEqual([]);
  });
});
