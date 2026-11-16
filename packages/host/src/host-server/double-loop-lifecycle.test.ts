import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setChatMode } from "../bots/index.ts";
import { createLoopStore } from "../loop/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "double-loop-lifecycle-"));
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

const usage = { input_tokens: 1, output_tokens: 1 };
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
const preToolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  hook: "PreToolUse",
  tool_use_id: id,
  input: { tool_name: name, tool_input: input, tool_use_id: id },
});
const toolResult = (id: string, content: string) => ({
  emit: {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
  },
});
const agentCall = (description: string) => ({
  subagent_type: "researcher",
  description,
  prompt: `Find out: ${description}`,
  run_in_background: true,
});
/** The CLI's `task_started`: for a new agent it names the Agent call, for a resumed one it does not. */
const taskStarted = (taskId: string, description: string, toolUseId?: string) => ({
  emit: {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    ...(toolUseId !== undefined && { tool_use_id: toolUseId }),
    description,
    subagent_type: "researcher",
  },
});
const subagentStop = (taskId: string, report: string) => ({
  hook: "SubagentStop",
  input: {
    agent_id: taskId,
    agent_type: "researcher",
    agent_transcript_path: "",
    stop_hook_active: false,
    last_assistant_message: report,
  },
});
const completed = (taskId: string) => ({
  emit: {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status: "completed",
    output_file: "",
    summary: "done",
  },
});
/** The front starts a researcher for a message; `after` is what happens once it runs. */
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
    taskStarted(taskId, description, toolUseId),
    { result: "On it." },
    ...after,
  ],
});

/** What the front does with the restart notice: it steers both agents back to work, which restarts them under their ids, and they report once the test lets them. */
const resumeScript = {
  match: "The app restarted",
  steps: [
    { text: "Picking both back up." },
    ...["agent-1", "agent-2"].flatMap((id, i) => [
      toolUse(`tu-resume-${i}`, "SendMessage", { to: id, message: "Continue where you stopped." }),
      preToolUse(`tu-resume-${i}`, "SendMessage", {
        to: id,
        message: "Continue where you stopped.",
      }),
      toolResult(`tu-resume-${i}`, "Message queued for delivery"),
      taskStarted(id, id === "agent-1" ? "research ALPHA" : "research BETA"),
    ]),
    { result: "Picking both back up." },
    { waitFor: "finish-resumed" },
    subagentStop("agent-1", "ALPHA costs $20."),
    completed("agent-1"),
    subagentStop("agent-2", "BETA costs $30."),
    completed("agent-2"),
    { text: "Both are done." },
    { result: "Both are done." },
  ],
};

const noticesOf = (bot: string) =>
  host.messageRecords(bot).filter((m) => m.text.startsWith("The app restarted"));
const reportsIn = (events: Streamed[]) => events.filter((e) => e.type === "report");

/** The scripts a test has given the fake CLI so far; it records which it used by position, so a later script goes after them. */
let base: { match?: string; steps: Record<string, unknown>[] }[] = [];

/** Two agents running for the bot, so each test starts from the same moment before the host or the CLI goes down. */
async function twoAgentsRunning(bot: string, after: Record<string, unknown>[] = []) {
  base = [
    startsAgent("research ALPHA", "tu-a", "agent-1", "research ALPHA", after),
    startsAgent("research BETA", "tu-b", "agent-2", "research BETA", after),
  ];
  host.loopScript(...base);
  const log = createLoopStore(host.db).session(bot, bot);
  await send("research ALPHA");
  await send("research BETA");
  await host.until(
    () =>
      log.getTask("agent-1")?.status === "running" && log.getTask("agent-2")?.status === "running",
  );
  return log;
}

describe("a host restart with two agents running", () => {
  test("the front is told once which agents were cut off, resumes both under their ids and both report", async () => {
    const bot = await doubleLoopBot();
    const log = await twoAgentsRunning(bot);
    const startedAt = log.getTask("agent-1")?.startedAt;
    host.loopScript(...base, resumeScript);

    await host.restart();

    // The agents died with the old process; the chat opening at host start hands the front the news.
    await host.until(() => noticesOf(bot).length === 1);
    const notice = defined(noticesOf(bot)[0], "notice");
    expect(notice).toMatchObject({ isSynthetic: true, priority: "next" });
    expect(notice.text.split("<work_state>")[0]).toBe(
      "The app restarted. These agents were interrupted:\n- id agent-1: research ALPHA\n- id agent-2: research BETA\nResume each with SendMessage to its id, telling it to continue where it stopped.\n\n",
    );

    // The scripted front resumed both: the same ids run again, and their goals and starts are the original ones.
    await host.until(
      () =>
        log.getTask("agent-1")?.status === "running" &&
        log.getTask("agent-2")?.status === "running",
    );
    expect(log.getTask("agent-1")).toMatchObject({ goal: "research ALPHA", startedAt });
    expect(log.events("steer").map((e) => [e.taskId, e.state])).toEqual([
      ["agent-1", "sent"],
      ["agent-2", "sent"],
    ]);
    expect(log.events("report")).toEqual([]);

    const watch = await watchEvents(host);
    host.allow("finish-resumed");
    await host.until(() => log.events("report").length === 2);
    await host.until(
      () => log.getTask("agent-1")?.status === "done" && log.getTask("agent-2")?.status === "done",
    );
    watch.stop();

    expect(log.events("report").map((e) => [e.taskId, e.text])).toEqual([
      ["agent-1", "ALPHA costs $20."],
      ["agent-2", "BETA costs $30."],
    ]);
    expect(createLoopStore(host.db).hasActive(bot)).toBe(false);
    // The notice came once, however often the chat was shown since.
    expect(noticesOf(bot)).toHaveLength(1);
  });

  test("the notice is sent once per front process: not again while it stays open, again after the next restart if the agents are still cut off", async () => {
    const bot = await doubleLoopBot();
    const log = await twoAgentsRunning(bot);
    // The front gets the notice and does nothing about it (no script, so the fake answers "ok"): the tasks stay interrupted.
    await host.restart();
    await host.until(() => noticesOf(bot).length === 1);
    expect(log.getTask("agent-1")?.status).toBe("interrupted");

    // The user writes to the same front process: it was told already.
    await send("how is it going?");
    await host.until(() => host.messageRecords(bot).some((m) => m.text.startsWith("how is it")));
    expect(noticesOf(bot)).toHaveLength(1);

    // A restart tells the new process again, because the tasks are still cut off.
    await host.restart();
    await host.until(() => noticesOf(bot).length === 2);
    expect(host.launches()).toHaveLength(3);
  });

  test("TaskStop on an interrupted agent cancels it, and nothing is reported for it", async () => {
    const bot = await doubleLoopBot();
    const log = await twoAgentsRunning(bot);
    await host.restart();
    await host.until(() => noticesOf(bot).length === 1);
    host.loopScript(...base, {
      match: "drop ALPHA",
      steps: [
        { text: "Dropping it now." },
        toolUse("tu-stop", "TaskStop", { task_id: "agent-1" }),
        preToolUse("tu-stop", "TaskStop", { task_id: "agent-1" }),
        { result: "Dropping it now." },
      ],
    });
    const watch = await watchEvents(host);

    await send("drop ALPHA");
    await host.until(() => log.getTask("agent-1")?.status === "cancelled");
    watch.stop();

    expect(log.getTask("agent-2")?.status).toBe("interrupted");
    expect(
      watch
        .events()
        .filter((e) => e.type === "task" && e.taskId === "agent-1")
        .map((e) => e.state),
    ).toContain("cancelled");
    expect(reportsIn(watch.events())).toEqual([]);
  });
});

describe("the front's CLI dying with agents running", () => {
  test("marks them interrupted at once, and the next message reaches a front that is told first", async () => {
    const bot = await doubleLoopBot();
    const watch = await watchEvents(host);
    const log = await twoAgentsRunning(bot, [{ waitFor: "crash" }, { exit: 1 }]);
    host.allow("crash");

    await host.until(() => log.getTask("agent-1")?.status === "interrupted");
    await host.until(() => log.getTask("agent-2")?.status === "interrupted");
    await host.until(() => watch.events().some((e) => e.type === "error"));
    await host.until(
      () =>
        watch
          .events()
          .filter((e) => e.type === "presence")
          .at(-1)?.state === "idle",
    );
    expect(createLoopStore(host.db).hasActive(bot)).toBe(false);
    // Nothing is told until the chat is used again.
    expect(noticesOf(bot)).toEqual([]);

    host.loopScript(...base, resumeScript);
    await send("are you still there?");
    await host.until(() => noticesOf(bot).length === 1);
    await host.until(() => host.messageRecords(bot).some((m) => m.text.startsWith("are you")));

    const texts = host.messageRecords(bot).map((m) => m.text.split("\n")[0]);
    expect(texts.slice(-2)).toEqual([
      "The app restarted. These agents were interrupted:",
      "are you still there?",
    ]);
    await host.until(
      () =>
        log.getTask("agent-1")?.status === "running" &&
        log.getTask("agent-2")?.status === "running",
    );
    watch.stop();
  });
});

describe("settings that change while agents run", () => {
  test("a changed setting closes the front once the agents are done, not before", async () => {
    const bot = await doubleLoopBot();
    const errors = spyOn(console, "error");
    const closedFor = (reason: string) =>
      errors.mock.calls.some((c) => String(c[0]).startsWith(`[host] front closed (${reason})`));
    try {
      host.loopScript(
        startsAgent("research ALPHA", "tu-a", "agent-1", "research ALPHA", [
          { waitFor: "finish-alpha" },
          subagentStop("agent-1", "ALPHA costs $20."),
          completed("agent-1"),
          { text: "That's done." },
          { result: "That's done." },
        ]),
      );
      const log = createLoopStore(host.db).session(bot, bot);
      await send("research ALPHA");
      await host.until(() => log.getTask("agent-1")?.status === "running");

      expect((await host.ui("/api/bots/browser", { botId: bot, enabled: true })).status).toBe(200);
      await send("hello");
      await host.until(() => host.messageRecords(bot).some((m) => m.text.startsWith("hello")));
      expect(closedFor("browser setting changed")).toBe(false);
      expect(host.launches()).toHaveLength(1);

      host.allow("finish-alpha");
      await host.until(() => log.getTask("agent-1")?.status === "done");
      await host.until(() => closedFor("browser setting changed"));

      await send("and again");
      await host.until(() => host.launches().length === 2);
    } finally {
      errors.mockRestore();
    }
  });
});
