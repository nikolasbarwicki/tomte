// Browser smoke of the double-loop chat mode (ADR-0011):
//   bun scripts/smoke-loop-ui.ts              (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as the other smokes: a temporary web build served by the whole-host test harness (in-memory database and secrets,
// temporary data root, `TOMTE_ASK_APPROVAL` on) driven by headless Chrome in a fresh profile. The "model" is the fake Claude
// CLI running the `loop.json` script written below, which stands in for the front's long-lived query: it streams the front's
// text, starts and ends background agents, records findings through the host's own hooks and in-process MCP server, steers and
// stops them, queues a task and asks the host for an agent's tool approval. No real model, OS notification or keychain is touched.
// Covers: the chat-mode toggle and its confirm dialog; a switch back refused (409) while a task runs; two messages a second
// apart, neither queued, the composer enabled and the presence line typing; a task with a moving status line, a finding, a second
// task, a steer, a cancel and a queued task that starts when its blocker ends; the report posted once as the bot's message with
// the task in its tooltip, kept by a page reload and by a rebuilt chat, with no `<work_state>` in sight; a worker's approval card
// while the front still answers, and the agent going on once it is allowed; the rate-limit indicator beside the context meter.
// Exits non-zero on the first failed check.
import { currentSession, getBot } from "../packages/host/src/bots/index.ts";
import { writeSession, type SessionLine } from "../packages/host/src/testing/session-file.ts";
import { recordRequests, startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("loop-ui", { env: { TOMTE_ASK_APPROVAL: "1" } });
const { host, page, check, pageErrors } = smoke;
const { sends } = recordRequests(page);
const startedAt = Date.now();

const botId = host.createBot("Loop");
const other = host.createBot("Plain");

// What the fake CLI emits, in the shapes the real CLI's SDK messages and hooks have.
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
const agentCall = (agent: string, description: string) => ({
  subagent_type: agent,
  description,
  prompt: `Do this: ${description}`,
  run_in_background: true,
});
const taskStarted = (taskId: string, toolUseId: string, description: string, agent: string) => ({
  emit: {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: agent,
  },
});
const taskProgress = (taskId: string, description: string, summary: string) => ({
  emit: {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    description,
    summary,
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  },
});
/** The front starts a background agent and its turn ends; `after` is what the agent does next. */
const startsAgent = (
  match: string,
  agent: string,
  toolUseId: string,
  taskId: string,
  description: string,
  reply: string,
  after: Record<string, unknown>[] = [],
) => ({
  match,
  steps: [
    { text: reply },
    toolUse(toolUseId, "Agent", agentCall(agent, description)),
    preToolUse(toolUseId, "Agent", agentCall(agent, description)),
    taskStarted(taskId, toolUseId, description, agent),
    { result: reply },
    ...after,
  ],
});
/** An agent's last words and the CLI's notification that it ended: the two signals the host posts a report from. */
const ends = (taskId: string, agent: string, report: string) => [
  {
    hook: "SubagentStop",
    input: {
      agent_id: taskId,
      agent_type: agent,
      agent_transcript_path: "",
      stop_hook_active: false,
      last_assistant_message: report,
    },
  },
  {
    emit: {
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status: "completed",
      output_file: "",
      summary: "done",
    },
  },
];
const rateLimit = (info: Record<string, unknown>) => ({
  emit: { type: "rate_limit_event", rate_limit_info: info },
});

const ZEBRA_REPORT = "Every zebra has its own stripe pattern, like a fingerprint.";
const COMPARE_REPORT = "Zebras are striped, quaggas only half so.";
const INVOICE_REPORT = "Sorted the invoices into one folder per month.";
const FINDING = { phase: "Stripes", finding: "No two zebras share a pattern.", next: "Check why." };
const QUEUE = { goal: "compare zebras and quaggas", agent: "researcher", after: "agent-1" };
const COMPARE_CALL = { ...agentCall("researcher", QUEUE.goal), name: "{queued}" };
const RESETS_IN_SECONDS = 2 * 3600 + 30;
const REPLIES = {
  "first message": "Looking at your first message.",
  "second message": "And the second one, noted.",
  "research Zebra": "On it, researching zebras.",
  "research Quagga": "Quaggas too, on it.",
  "focus Zebra": "Passing that on to the zebra researcher.",
  "drop Quagga": "Dropping the quagga research.",
  "after Zebra ends": "Okay, I'll do that when the zebra research is done.",
  "tidy the invoices": "The worker is on the invoices.",
  "status check": "Still on the invoices.",
} as const;

// One script per message the page sends, in no particular order: a message takes the first unused script it contains the match of.
host.loopScript(
  {
    match: "first message",
    steps: [
      { text: REPLIES["first message"] },
      rateLimit({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.62,
        resetsAt: Math.floor(Date.now() / 1000) + RESETS_IN_SECONDS,
      }),
      rateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.2 }),
      // The turn stays open until the smoke lets it end, as a long front turn would.
      { waitFor: "first-done" },
      { result: REPLIES["first message"] },
    ],
  },
  {
    match: "second message",
    steps: [{ text: REPLIES["second message"] }, { result: REPLIES["second message"] }],
  },
  startsAgent(
    "research Zebra",
    "researcher",
    "tu-zebra",
    "agent-1",
    "research Zebra",
    REPLIES["research Zebra"],
    [
      taskProgress("agent-1", "research Zebra", "Searching zebra sources"),
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
      { waitFor: "zebra-2" },
      taskProgress("agent-1", "research Zebra", "Reading the zebra report"),
      { waitFor: "end-zebra" },
      ...ends("agent-1", "researcher", ZEBRA_REPORT),
      { text: "That's the zebra research done." },
      { result: "That's the zebra research done." },
    ],
  ),
  startsAgent(
    "research Quagga",
    "researcher",
    "tu-quagga",
    "agent-2",
    "research Quagga",
    REPLIES["research Quagga"],
    [taskProgress("agent-2", "research Quagga", "Checking quagga habitats")],
  ),
  {
    match: "focus Zebra",
    steps: [
      { text: REPLIES["focus Zebra"] },
      toolUse("tu-steer", "SendMessage", { to: "agent-1", message: "Focus on the pricing." }),
      preToolUse("tu-steer", "SendMessage", { to: "agent-1", message: "Focus on the pricing." }),
      { result: REPLIES["focus Zebra"] },
    ],
  },
  {
    match: "drop Quagga",
    steps: [
      { text: REPLIES["drop Quagga"] },
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
      { result: REPLIES["drop Quagga"] },
    ],
  },
  {
    match: "after Zebra ends",
    steps: [
      { text: REPLIES["after Zebra ends"] },
      toolUse("tu-queue", "mcp__loop__queue_task", QUEUE),
      { mcp: { server: "loop", tool: "queue_task", args: QUEUE } },
      { result: REPLIES["after Zebra ends"] },
    ],
  },
  {
    // The app's request to start the queued task, which the front answers with an Agent call that names the queue id.
    match: "Start queued task",
    steps: [
      toolUse("tu-compare", "Agent", COMPARE_CALL),
      preToolUse("tu-compare", "Agent", COMPARE_CALL),
      taskStarted("agent-3", "tu-compare", QUEUE.goal, "researcher"),
      { result: "" },
      taskProgress("agent-3", QUEUE.goal, "Comparing the two"),
      { waitFor: "end-compare" },
      ...ends("agent-3", "researcher", COMPARE_REPORT),
    ],
  },
  startsAgent(
    "tidy the invoices",
    "worker",
    "tu-worker",
    "agent-4",
    "tidy the invoices",
    REPLIES["tidy the invoices"],
    [
      // The worker's shell needs the user's say-so: the host asks, and the agent waits for the answer.
      { canUseTool: { tool_name: "Bash", input: { command: "ls invoices" }, agent_id: "agent-4" } },
      ...ends("agent-4", "worker", INVOICE_REPORT),
    ],
  ),
  {
    match: "status check",
    steps: [{ text: REPLIES["status check"] }, { result: REPLIES["status check"] }],
  },
);

// The page.
const box = page.getByRole("textbox", { name: "Message Loop", exact: true });
const sendButton = page.getByRole("button", { name: "Send", exact: true });
const rail = page.getByRole("navigation", { name: /panel$/ });
const modelChip = page.getByRole("button", { name: "Model and chat" });
const doubleLoopMode = page.getByRole("radio", { name: /^Double loop/ });
const oneThreadMode = page.getByRole("radio", { name: /^One thread/ });
const needsDoubleLoop = page.getByTestId("tasks-need-double-loop");
const noTasksYet = page.getByText("No tasks yet", { exact: true });
const limits = page.getByTestId("rate-limits");
const presenceLine = (text: string) => page.getByRole("status").filter({ hasText: text });
const task = (id: string) => page.locator(`[data-task="${id}"]`);
// The sidebar also quotes each bot's last message, so what the transcript shows is looked up in its own region.
const transcript = page.getByRole("region", { name: "Messages" });
const said = (text: string) => transcript.getByText(text, { exact: true });

const say = async (text: string) => {
  const before = sends.length;
  await box.fill(text);
  await sendButton.click();
  await host.until(() => sends.length > before);
  return sends.at(-1)!;
};
/** Opens a section of the panel from the rail; its icon closes the panel while that section is open, so one already open stays. */
const openSection = async (name: string) => {
  const icon = rail.getByRole("button", { name, exact: true });
  if ((await icon.getAttribute("aria-pressed")) !== "true") await icon.click();
  await page.locator(`[data-panel-section="${name.toLowerCase()}"]`).waitFor();
};
/** Opens the model chip's popover: the chat mode, the model and the effort. */
const openModelChip = async () => {
  await modelChip.click();
  await doubleLoopMode.waitFor();
};
/** Waits until the chat mode can switch again: nothing runs and the bot is not replying. Leaves the popover open. */
const waitIdle = async () => {
  await openModelChip();
  await page.waitForFunction(
    () => {
      const radios = [...document.querySelectorAll('[role="radio"]')];
      return (
        radios.length === 2 &&
        radios.every(
          (r) => !r.hasAttribute("data-disabled") && r.getAttribute("aria-disabled") !== "true",
        )
      );
    },
    undefined,
    { timeout: 8000 },
  );
};
/** How many times the page shows `text`. */
const shown = (text: string) => said(text).count();

try {
  console.log(
    "a standard bot shows no rate limit and its Tasks section says it needs double-loop chat",
  );
  await page.goto(`${host.clientUrl}/bots/${botId}`);
  await box.waitFor();
  check((await limits.count()) === 0, "no rate-limit indicator for a standard bot");
  await openSection("Tasks");
  await needsDoubleLoop.waitFor();
  check(true, "the Tasks section of a standard bot says background tasks need double-loop chat");
  check(
    (await modelChip.innerText()).includes("Sonnet") &&
      (await modelChip.locator("svg").count()) === 1,
    "the chip names the model and has no split arrow",
  );

  console.log("the toggle, in the model chip's popover");
  await openModelChip();
  check(
    await page.getByText("Model", { exact: true }).first().isVisible(),
    "a standard bot's popover names its model",
  );
  check(await oneThreadMode.isChecked(), "One thread is the chosen chat mode");
  await doubleLoopMode.click();
  await page.getByRole("alertdialog").getByText("Switch to double-loop chat for Loop?").waitFor();
  await smoke.shot("confirm-switch");
  await page.getByRole("button", { name: "Switch and start new" }).click();
  await noTasksYet.waitFor();
  check(true, "the confirm dialog switches the bot, and its Tasks section is the task list");
  const sessionId = currentSession(getBot(host.dataRoot, botId)!)!;
  check(sessionId !== botId, "switching started a new session");
  await openModelChip();
  await page.getByText("Background tasks run on", { exact: true }).waitFor();
  check(true, "in double-loop mode the model and effort are the background tasks'");
  const modelChoice = page.getByRole("group", { name: "Model" });
  await modelChoice.getByRole("button", { name: "Opus" }).click();
  await host.until(() => getBot(host.dataRoot, botId)?.model === "opus");
  await modelChoice.getByRole("button", { name: "Opus", pressed: true }).waitFor();
  check(true, "picking a model saves it with the bot, and the popover shows it");
  check((await modelChip.innerText()).includes("Opus"), "the chip follows the model");
  await smoke.shot("model-popover");
  await page.keyboard.press("Escape");
  await doubleLoopMode.waitFor({ state: "detached" });

  console.log("two messages a second apart");
  const first = await say("first message");
  check(first.json?.outcome === "sent", "the first message is sent");
  await said(REPLIES["first message"]).waitFor();
  await Bun.sleep(1000);
  check(await presenceLine("Loop is typing").isVisible(), "the presence line says typing");
  check(await box.isEditable(), "the composer stays enabled while the front is typing");
  const second = await say("second message");
  check(second.json?.outcome === "sent", "the second message is sent, not queued");
  await said(REPLIES["second message"]).waitFor();
  check(
    sends.every((s) => s.json?.queued === undefined && s.json?.outcome === "sent"),
    "no message was queued",
  );
  check(
    (await page.getByText("first message", { exact: true }).count()) === 1 &&
      (await page.getByText("second message", { exact: true }).count()) === 1,
    "both messages show as sent in the transcript",
  );
  host.allow("first-done");
  await presenceLine("typing").waitFor({ state: "detached" });
  check(await box.isEditable(), "the composer is enabled after the turns end");

  console.log("the rate limit");
  await limits.waitFor();
  check(
    ((await limits.innerText()) ?? "").includes("62%") &&
      (await limits.getAttribute("data-status")) === "allowed_warning",
    "the indicator shows the most pressing window",
  );
  await limits.hover();
  await page.getByText("Weekly limit", { exact: true }).waitFor();
  check(
    await page.getByText("Resets in 2h").first().isVisible(),
    "the hover card lists the 5-hour reset",
  );
  check(await page.getByText("20% used").isVisible(), "the hover card lists the weekly window");
  await smoke.shot("rate-limits");
  await page.mouse.move(700, 450);

  console.log("a research task");
  await openSection("Tasks");
  await say("research Zebra");
  await said(REPLIES["research Zebra"]).waitFor();
  await task("agent-1").getByText("research Zebra").waitFor();
  await task("agent-1").getByText("Searching zebra sources").waitFor();
  check(true, "the Tasks section shows the task running with its status line");
  await task("agent-1").getByLabel("Findings").getByText(FINDING.finding).waitFor();
  check(true, "the finding is listed under the task");
  check(
    await presenceLine("Loop is working").isVisible(),
    "the presence line says working while the agent runs",
  );
  host.allow("zebra-2");
  await task("agent-1").getByText("Reading the zebra report").waitFor();
  check(
    (await transcript.getByText("Working on:").count()) === 0 &&
      (await presenceLine("Loop is working on 1 task").isVisible()),
    "the transcript shows no task rows, and the presence line counts the running task",
  );
  check(
    (await transcript.getByText("Agent", { exact: true }).count()) === 0,
    "the front's tool calls are not shown",
  );
  await openModelChip();
  check(
    (await doubleLoopMode.isDisabled()) && (await oneThreadMode.isDisabled()),
    "the chat mode is locked while a task runs",
  );
  await page.keyboard.press("Escape");
  await openSection("Tasks");

  console.log("a second task, a steer and a cancel");
  await say("research Quagga");
  await task("agent-2").getByText("Checking quagga habitats").waitFor();
  check(
    (await page.locator('[data-task][data-state="running"]').count()) === 2,
    "two tasks run in parallel",
  );
  await say("focus Zebra on pricing");
  await said(REPLIES["focus Zebra"]).waitFor();
  await say("drop Quagga");
  await task("agent-2").and(page.locator('[data-state="cancelled"]')).waitFor();
  check(
    (await task("agent-2").innerText()).includes("Stopped"),
    "the cancelled task moves to Recent as stopped",
  );
  const records = host.messageRecords(sessionId);
  check(
    records.at(-1)?.text.includes("instructions sent so far: 1") === true,
    "the front's next work state counts the steer",
  );
  check(
    records.at(-1)?.text.includes(FINDING.finding) === true,
    "the front's work state carries the finding",
  );

  console.log("a mode switch while a task runs");
  const refused = await host.ui("/api/bots/chat-mode", { botId, chatMode: "standard" });
  const refusal: { error?: string } = await refused.json();
  check(refused.status === 409, "switching back is refused with 409");
  check(refusal.error === "stop the running tasks first", "the refusal says to stop the tasks");

  console.log("a queued task");
  await say("do the comparison after Zebra ends");
  await said(REPLIES["after Zebra ends"]).waitFor();
  const queued = page.locator('[data-task][data-state="queued"]');
  await queued.waitFor();
  check(
    (await queued.innerText()).includes(QUEUE.goal) &&
      (await queued.innerText()).includes("research Zebra"),
    "the queued task waits for the zebra task",
  );
  check(
    !host.messageRecords(sessionId).some((m) => m.text.startsWith("Start queued task")),
    "nothing is asked of the front while the blocker runs",
  );
  await smoke.shot("tasks");

  console.log("the report");
  host.allow("end-zebra");
  await said(ZEBRA_REPORT).waitFor();
  await said("That's the zebra research done.").waitFor();
  check((await shown(ZEBRA_REPORT)) === 1, "the report is posted once");
  await page.mouse.move(700, 450);
  await task("agent-1").and(page.locator('[data-state="done"]')).waitFor();
  const dispatches = () =>
    host.messageRecords(sessionId).filter((m) => m.text.startsWith("Start queued task"));
  await host.until(() => dispatches().length > 0);
  const dispatch = dispatches()[0];
  check(
    dispatch?.isSynthetic === true &&
      dispatch.text.startsWith(`Start queued task q-`) &&
      dispatch.text.includes(`(agent: researcher): ${QUEUE.goal}`),
    "the front is asked, by a message the app wrote, to start the queued task when its blocker ends",
  );
  await task("agent-3").and(page.locator('[data-state="running"]')).waitFor();
  check((await queued.count()) === 0, "the queued task started and left the queue");
  host.allow("end-compare");
  await said(COMPARE_REPORT).waitFor();
  check((await shown(COMPARE_REPORT)) === 1, "the queued task's report is posted once");
  await task("agent-3").and(page.locator('[data-state="done"]')).waitFor();

  console.log("a worker's approval");
  await say("tidy the invoices");
  await said(REPLIES["tidy the invoices"]).waitFor();
  await page.getByText('shell command, for the task "tidy the invoices"').waitFor();
  check(
    await page.getByRole("button", { name: "Allow", exact: true }).isVisible(),
    "an approval card for the worker's shell appears and names the task",
  );
  await smoke.shot("approval");
  await say("status check");
  await said(REPLIES["status check"]).waitFor();
  check(
    host.permissionResults().length === 0 &&
      (await page.getByRole("button", { name: "Allow", exact: true }).isVisible()),
    "the front answered while the card is still open, and the worker waits",
  );
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await said(INVOICE_REPORT).waitFor();
  const permission = host.permissionResults()[0];
  check(
    permission?.tool_name === "Bash" &&
      permission.agent_id === "agent-4" &&
      permission.response?.behavior === "allow",
    "the worker went on once the user allowed it",
  );
  await task("agent-4").and(page.locator('[data-state="done"]')).waitFor();
  await waitIdle();

  console.log("a page reload and a rebuilt chat");
  // The fake CLI writes no session file, so the file the real one would have written: what the front was sent (work state and all) and said.
  const lines: SessionLine[] = host.messageRecords(sessionId).flatMap((m, i): SessionLine[] => {
    const key = (Object.keys(REPLIES) as (keyof typeof REPLIES)[]).find((k) =>
      m.text.startsWith(k),
    );
    return [
      {
        role: "user",
        text: m.text,
        at: startedAt + i * 2000,
        extra: { origin: m.origin ?? { kind: "task-notification" } },
      },
      ...(key
        ? [{ role: "assistant" as const, text: REPLIES[key], at: startedAt + i * 2000 + 1 }]
        : []),
    ];
  });
  check(
    lines.some((l) => l.text.includes("<work_state>")),
    "the front was sent a work state with its messages",
  );
  writeSession(host, botId, lines, sessionId);
  const noWorkState = async (what: string) => {
    check(
      !(await page.locator("body").innerText()).includes("work_state"),
      `no <work_state> text on the page ${what}`,
    );
    check(!(await page.content()).includes("&lt;work_state&gt;"), `no escaped work state ${what}`);
  };
  const reportsOnce = async (what: string) => {
    for (const r of [ZEBRA_REPORT, COMPARE_REPORT, INVOICE_REPORT])
      check((await shown(r)) === 1, `"${r.slice(0, 24)}…" is shown once ${what}`);
  };

  await page.reload();
  await box.waitFor();
  await said(ZEBRA_REPORT).waitFor();
  await reportsOnce("after a reload");
  await noWorkState("after a reload");
  check((await shown("research Zebra")) >= 1, "the typed messages show after a reload");

  // Leaving the bot closes its idle chat; opening it again rebuilds the transcript from the session file and the stored log.
  await page.goto(`${host.clientUrl}/bots/${other}`);
  await page.getByRole("textbox", { name: "Message Plain", exact: true }).waitFor();
  await page.goto(`${host.clientUrl}/bots/${botId}`);
  await box.waitFor();
  await said(ZEBRA_REPORT).waitFor();
  await reportsOnce("in a rebuilt chat");
  await noWorkState("in a rebuilt chat");
  for (const [typed, times] of [
    ["first message", 1],
    ["second message", 1],
    ["research Zebra", 1],
  ] as const)
    check((await shown(typed)) === times, `"${typed}" is shown as typed in the rebuilt chat`);
  await said(REPLIES["first message"]).waitFor();
  check(
    (await said("Start queued task").count()) === 0 &&
      !(await page.locator("body").innerText()).includes("Start queued task"),
    "the app's own messages are not shown",
  );
  await openSection("Tasks");
  for (const [id, state] of [
    ["agent-1", "done"],
    ["agent-2", "cancelled"],
    ["agent-3", "done"],
    ["agent-4", "done"],
  ] as const)
    await task(id)
      .and(page.locator(`[data-state="${state}"]`))
      .waitFor();
  check(true, "the Tasks section lists the four tasks as they ended");
  await limits.waitFor();
  check(true, "the rate limit is still shown after the chat was rebuilt");
  await smoke.shot("rebuilt");

  console.log("leaving double-loop mode once nothing runs");
  await waitIdle();
  await oneThreadMode.click();
  await page.getByRole("alertdialog").getByText("Leave double-loop chat for Loop?").waitFor();
  await page.getByRole("button", { name: "Switch and start new" }).click();
  await page.keyboard.press("Escape");
  await openSection("Tasks");
  await needsDoubleLoop.waitFor();
  check(
    (await limits.count()) === 0,
    "the Tasks section asks for double-loop chat and the rate-limit indicator is gone in standard mode",
  );

  check(pageErrors.length === 0, `no page errors (${pageErrors.join("; ")})`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
