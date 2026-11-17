import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botFilesPath, setChatMode } from "../bots/index.ts";
import { createLoopStore } from "../loop/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost | undefined;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

async function start(flags: string[] = [], env: Record<string, string> = {}) {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "double-loop-worker-")));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost(
    ["--data-root", join(scratch, "state"), ...flags],
    undefined,
    undefined,
    undefined,
    env,
  );
  return host;
}
afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

async function doubleLoopBot(h: HandoffHost) {
  const id = h.createBot("Dev");
  setChatMode(h.dataRoot, id, "double_loop");
  expect((await h.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

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
const preToolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  agentId?: string,
) => ({
  hook: "PreToolUse",
  tool_use_id: id,
  input: {
    tool_name: name,
    tool_input: input,
    tool_use_id: id,
    ...(agentId !== undefined && { agent_id: agentId }),
  },
});
const WORKER_CALL = {
  subagent_type: "worker",
  description: "tidy the invoices",
  prompt: "Tidy the invoices.",
  run_in_background: true,
};
/** The front starts a worker, `agent-1`, and the turn ends; `after` is what the worker does next. */
const startsWorker = (match: string, after: Record<string, unknown>[]) => ({
  match,
  steps: [
    { text: "On it." },
    toolUse("tu-agent", "Agent", WORKER_CALL),
    preToolUse("tu-agent", "Agent", WORKER_CALL),
    {
      emit: {
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "tu-agent",
        description: WORKER_CALL.description,
        subagent_type: "worker",
      },
    },
    { result: "On it." },
    ...after,
  ],
});

const decision = (response: unknown) =>
  (response as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
const hooked = (h: HandoffHost, tool: string) =>
  h
    .hookResults()
    .filter((r) => r.hook === "PreToolUse" && r.input.tool_name === tool)
    .map((r) => ({ input: r.input.tool_input, decision: decision(r.response) }));

describe("a worker's file tools", () => {
  test("work in the workspace and the bot's files folder, and a path outside them is refused and logged for the task", async () => {
    const h = await start();
    const bot = await doubleLoopBot(h);
    const inside = [join(h.cwd, "notes.md"), join(botFilesPath(h.dataRoot, bot), "invoices.csv")];
    const outside = [
      "/etc/passwd",
      "../secrets.enc",
      join(h.dataRoot, "bots", "other", "memory.md"),
    ];
    h.loopScript(
      startsWorker("tidy", [
        ...[...inside, ...outside].map((file_path, i) =>
          preToolUse(`tu-w${i}`, "Write", { file_path, content: "x" }, "agent-1"),
        ),
        preToolUse("tu-g", "Glob", { pattern: "/etc/*.conf" }, "agent-1"),
        { waitFor: "end" },
      ]),
    );
    expect((await h.ui("/api/send", { text: "tidy the invoices" })).status).toBe(200);
    await h.until(() => hooked(h, "Glob").length === 1);

    expect(hooked(h, "Write")).toEqual([
      ...inside.map((file_path) => ({ input: { file_path, content: "x" }, decision: undefined })),
      ...outside.map((file_path) => ({ input: { file_path, content: "x" }, decision: "deny" })),
    ]);
    expect(hooked(h, "Glob")[0]?.decision).toBe("deny");

    const activity = createLoopStore(h.db)
      .session(bot, bot)
      .events("activity")
      .map((e) => String(e.text));
    expect(activity.filter((t) => t.includes("refused"))).toHaveLength(4);
    expect(activity.find((t) => t.startsWith("Write refused: /etc/passwd"))).toContain(
      "outside the places you may work in",
    );
    h.allow("end");
  });

  test("the front's own calls are not held to the boundary", async () => {
    const h = await start();
    await doubleLoopBot(h);
    h.loopScript({
      match: "read it",
      steps: [preToolUse("tu-r", "Read", { file_path: "/etc/hosts" }), { result: "Read it." }],
    });
    expect((await h.ui("/api/send", { text: "read it" })).status).toBe(200);
    await h.until(() => hooked(h, "Read").length === 1);

    expect(hooked(h, "Read")[0]?.decision).toBeUndefined();
  });
});

describe("TaskStop", () => {
  test("stops an agent of the chat, and is refused for an id that is not one", async () => {
    const h = await start();
    const bot = await doubleLoopBot(h);
    h.loopScript(startsWorker("tidy", [{ waitFor: "end" }]), {
      match: "stop things",
      steps: [
        preToolUse("tu-s1", "TaskStop", { task_id: "agent-1" }),
        preToolUse("tu-s2", "TaskStop", { task_id: "bash-77" }),
        preToolUse("tu-s3", "TaskStop", { shell_id: "agent-1" }),
        { result: "Done." },
      ],
    });
    expect((await h.ui("/api/send", { text: "tidy the invoices" })).status).toBe(200);
    await h.until(() => createLoopStore(h.db).session(bot, bot).getTask("agent-1") !== undefined);
    expect((await h.ui("/api/send", { text: "stop things" })).status).toBe(200);
    await h.until(() => hooked(h, "TaskStop").length === 3);

    expect(hooked(h, "TaskStop").map((r) => r.decision)).toEqual([undefined, "deny", "deny"]);
    h.allow("end");
  });

  test("under a disabled shell the front keeps TaskStop while Bash is gone from the worker and the session", async () => {
    const h = await start([
      "--mode",
      "remote",
      "--secrets-key-file",
      "/etc/tomte-test/secrets.key",
    ]);
    h.setSandboxAvailable(false);
    const bot = await doubleLoopBot(h);
    h.loopScript({ steps: [] });
    expect((await h.ui("/api/send", { text: "hello" })).status).toBe(200);
    await h.until(() => h.messagesOf(bot).length === 1);

    const launch = defined(h.launches().at(-1), "launch");
    const disallowed = defined(
      launch.argv.find((a) => a.startsWith("--disallowedTools=")),
      "--disallowedTools",
    );
    expect(disallowed).toContain("Bash");
    expect(disallowed).not.toContain("TaskStop");
    expect(launch.argv.join(" ")).toMatch(/--tools=Agent,SendMessage,TaskStop,/);
    expect(launch.argv.join(" ")).not.toMatch(/--tools=\S*Bash/);
    expect(launch.agents?.worker?.tools).not.toContain("Bash");
  });
});

describe("the agent definitions a launch carries", () => {
  test("the worker has the shell where the bot has one and the front is denied every agent tool", async () => {
    const h = await start();
    const bot = await doubleLoopBot(h);
    h.loopScript({ steps: [] });
    expect((await h.ui("/api/send", { text: "hello" })).status).toBe(200);
    await h.until(() => h.messagesOf(bot).length === 1);

    const agents = defined(h.launches()[0]?.agents, "agents");
    const worker = defined(agents.worker, "worker");
    const front = defined(agents.front, "front");
    expect(worker.tools).toContain("Bash");
    expect(worker.tools).toContain("mcp__host__ask_user");
    expect(worker.prompt).toContain("Dev");
    for (const tool of [...(worker.tools ?? []), ...(agents.researcher?.tools ?? [])])
      expect(front.disallowedTools ?? []).toContain(tool);
    expect(front.disallowedTools).not.toContain("mcp__loop__queue_task");
    expect(front.disallowedTools).not.toContain("Agent");
  });
});

describe("a worker's question", () => {
  test("is a card that names the task, and the answer goes back to the worker; one from the front is a plain card", async () => {
    const h = await start();
    await doubleLoopBot(h);
    const watch = await watchEvents(h);
    const ask = (tool_use_id: string, question: string) => ({
      mcp: { server: "host", tool: "ask_user", args: { question }, tool_use_id },
    });
    h.loopScript(
      startsWorker("tidy", [
        preToolUse("tu-ask", "mcp__host__ask_user", { question: "Which folder?" }, "agent-1"),
        ask("tu-ask", "Which folder?"),
      ]),
      { match: "front asks", steps: [ask("tu-front", "Sure?"), { result: "Asked." }] },
    );
    expect((await h.ui("/api/send", { text: "tidy the invoices" })).status).toBe(200);
    const questions = () => watch.events().filter((e) => e.type === "ask");
    await h.until(() => questions().length === 1);
    expect(questions()[0]?.question).toBe('Task "tidy the invoices" asks: Which folder?');

    expect(
      (await h.ui("/api/answer", { id: String(questions()[0]?.id), value: "Invoices" })).status,
    ).toBe(200);
    await h.until(() => h.loopCalls().some((c) => c.tool === "ask_user"));
    expect(h.loopCalls().find((c) => c.tool === "ask_user")?.result?.content[0]?.text).toContain(
      "Invoices",
    );

    // A call with no agent in front of it, or one the hook never saw, is the front's own.
    expect((await h.ui("/api/send", { text: "front asks" })).status).toBe(200);
    await h.until(() => questions().length === 2);
    expect(questions()[1]?.question).toBe("Sure?");
    watch.stop();
  });
});

describe("approvals asked of a worker", () => {
  const BASH = { command: "ls invoices" };

  test("become a card that names the task while the front keeps answering, and the worker goes on once the user allows it", async () => {
    const h = await start([], { TOMTE_ASK_APPROVAL: "1" });
    const bot = await doubleLoopBot(h);
    const watch = await watchEvents(h);
    h.loopScript(
      startsWorker("tidy", [
        { canUseTool: { tool_name: "Bash", input: BASH, agent_id: "agent-1" } },
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
        {
          hook: "SubagentStop",
          input: {
            agent_id: "agent-1",
            agent_type: "worker",
            agent_transcript_path: "",
            stop_hook_active: false,
            last_assistant_message: "Sorted the invoices into folders.",
          },
        },
      ]),
      { match: "status", steps: [{ text: "Still on the invoices." }, { result: "Still." }] },
    );
    expect((await h.ui("/api/send", { text: "tidy the invoices" })).status).toBe(200);

    const card = async () => {
      await h.until(() => watch.events().some((e) => e.type === "approve"));
      return defined(
        watch.events().find((e) => e.type === "approve"),
        "approve card",
      );
    };
    expect(await card()).toMatchObject({
      tool: "Bash",
      reason: 'shell command, for the task "tidy the invoices"',
    });
    expect(h.permissionResults()).toEqual([]);

    // The card waits for the user; the front still takes the next message.
    expect((await h.ui("/api/send", { text: "status?" })).status).toBe(200);
    await h.until(() =>
      watch.events().some((e) => e.type === "delta" && String(e.text).includes("Still")),
    );
    expect(h.permissionResults()).toEqual([]);

    const id = String((await card()).id);
    expect((await h.ui("/api/answer", { id, value: "allow" })).status).toBe(200);
    await h.until(() => h.permissionResults().length === 1);
    expect(h.permissionResults()[0]).toMatchObject({
      tool_name: "Bash",
      agent_id: "agent-1",
      response: { behavior: "allow" },
    });
    await h.until(() => watch.events().some((e) => e.type === "report"));
    expect(watch.events().find((e) => e.type === "report")).toMatchObject({
      taskId: "agent-1",
      text: "Sorted the invoices into folders.",
    });
    expect(createLoopStore(h.db).session(bot, bot).getTask("agent-1")?.status).toBe("done");
    watch.stop();
  });

  test("a declined approval is denied to the worker, which then carries on", async () => {
    const h = await start([], { TOMTE_ASK_APPROVAL: "1" });
    await doubleLoopBot(h);
    const watch = await watchEvents(h);
    h.loopScript(
      startsWorker("tidy", [
        {
          canUseTool: {
            tool_name: "Bash",
            input: BASH,
            agent_id: "agent-1",
            ifDenied: [preToolUse("tu-after", "Glob", { pattern: "*.csv" }, "agent-1")],
          },
        },
      ]),
    );
    expect((await h.ui("/api/send", { text: "tidy the invoices" })).status).toBe(200);
    await h.until(() => watch.events().some((e) => e.type === "approve"));
    const id = String(
      defined(
        watch.events().find((e) => e.type === "approve"),
        "card",
      ).id,
    );
    expect((await h.ui("/api/answer", { id, value: "deny" })).status).toBe(200);
    await h.until(() => hooked(h, "Glob").length === 1);

    expect(h.permissionResults()[0]).toMatchObject({
      response: { behavior: "deny", message: "user declined" },
    });
    watch.stop();
  });
});
