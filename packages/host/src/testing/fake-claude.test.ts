import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");

let dir: string;
let open: Query[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-claude-loop-"));
});

afterEach(() => {
  for (const q of open) q.close();
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

const script = (...scripts: object[]) =>
  writeFileSync(join(dir, "loop.json"), JSON.stringify({ scripts }));
const lines = (file: string) =>
  existsSync(join(dir, file))
    ? readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const user = (text: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  ...extra,
});

/** Drives the fake through the real SDK, as the host does: the prompt is an async iterable the test feeds. */
function start(options: Partial<Options> = {}) {
  const queue: SDKUserMessage[] = [];
  const wake: { resolve?: () => void } = {};
  let closed = false;
  async function* prompt() {
    while (!closed) {
      const next = queue.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => (wake.resolve = resolve));
    }
  }
  const q = query({
    prompt: prompt(),
    options: {
      pathToClaudeCodeExecutable: FAKE_CLAUDE,
      env: { ...process.env, FAKE_CLAUDE_DIR: dir },
      cwd: dir,
      includePartialMessages: true,
      ...options,
    },
  });
  open.push(q);
  const messages: SDKMessage[] = [];
  const waiters: { test: (m: SDKMessage) => boolean; resolve: (m: SDKMessage) => void }[] = [];
  const ended = (async () => {
    try {
      for await (const m of q) {
        messages.push(m);
        for (const w of waiters.filter((x) => x.test(m))) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  return {
    q,
    messages,
    /** Settles when the CLI's output ends, with the error if it exited non-zero. */
    ended,
    push(message: SDKUserMessage) {
      queue.push(message);
      wake.resolve?.();
    },
    stop() {
      closed = true;
      wake.resolve?.();
    },
    /** The first message, already received or yet to come, that satisfies `match`. */
    next(match: (m: SDKMessage) => boolean) {
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      const { promise, resolve } = Promise.withResolvers<SDKMessage>();
      waiters.push({ test: match, resolve });
      return promise;
    },
  };
}
const isResult = (text: string) => (m: SDKMessage) =>
  m.type === "result" && m.subtype === "success" && m.result === text;

describe("fake Claude CLI loop script", () => {
  test("emits task events, calls hooks and an in-process MCP server, and records the results", async () => {
    const noted: string[] = [];
    const loop = createSdkMcpServer({
      name: "loop",
      tools: [
        tool("note", "Records a note", { text: z.string() }, async ({ text }) => {
          noted.push(text);
          return { content: [{ type: "text", text: `noted ${text}` }] };
        }),
      ],
    });
    const preToolUse: HookCallback = async (input) => {
      expect(input.hook_event_name).toBe("PreToolUse");
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "unknown task",
        },
      };
    };
    script({
      steps: [
        {
          emit: {
            type: "system",
            subtype: "task_started",
            task_id: "t1",
            description: "scan the inbox",
          },
        },
        {
          emit: {
            type: "system",
            subtype: "task_progress",
            task_id: "t1",
            description: "scan the inbox",
            summary: "read 3 of 9",
            usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
          },
        },
        {
          hook: "PreToolUse",
          input: { tool_name: "TaskStop", tool_input: { task_id: "nope" } },
          tool_use_id: "tu-1",
          ifDenied: [{ text: "refused {session}" }],
        },
        {
          hook: "PreToolUse",
          input: { tool_name: "Read", tool_input: {} },
        },
        { mcp: { server: "loop", tool: "note", args: { text: "message {n}" } } },
        { result: "turn {n} done" },
        {
          emit: {
            type: "system",
            subtype: "task_notification",
            task_id: "t1",
            status: "completed",
            output_file: "/tmp/t1.out",
            summary: "inbox scanned",
          },
        },
      ],
    });
    const run = start({
      mcpServers: { loop },
      hooks: { PreToolUse: [{ matcher: "TaskStop", hooks: [preToolUse] }] },
    });
    run.push(user("scan"));

    const notification = await run.next(
      (m) => m.type === "system" && m.subtype === "task_notification",
    );
    expect(notification).toMatchObject({
      status: "completed",
      summary: "inbox scanned",
      task_id: "t1",
    });
    const types = run.messages.map((m) => (m.type === "system" ? `system:${m.subtype}` : m.type));
    expect(types.filter((t) => t.startsWith("system:task_"))).toEqual([
      "system:task_started",
      "system:task_progress",
      "system:task_notification",
    ]);
    expect(
      run.messages.find((m) => m.type === "system" && m.subtype === "task_progress"),
    ).toMatchObject({
      summary: "read 3 of 9",
    });
    expect(run.messages.find(isResult("turn 0 done"))).toBeDefined();
    const deltas = run.messages.filter(
      (m) => m.type === "stream_event" && m.event.type === "content_block_delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    const refusal = run.messages.find(
      (m) => m.type === "assistant" && JSON.stringify(m.message.content).includes("refused"),
    );
    expect(refusal).toBeDefined();
    expect(noted).toEqual(["message 0"]);

    const hookResults = lines("hook-results.jsonl");
    expect(hookResults).toHaveLength(2);
    expect(hookResults[0]).toMatchObject({
      hook: "PreToolUse",
      input: { tool_name: "TaskStop" },
      response: { hookSpecificOutput: { permissionDecision: "deny" } },
    });
    // The Read call matches no registered matcher, so no callback runs.
    expect(hookResults[1]).toMatchObject({ input: { tool_name: "Read" }, callback: null });
    expect(lines("tool-results.jsonl")).toMatchObject([
      { server: "loop", tool: "note", result: { content: [{ text: "noted message 0" }] } },
    ]);
  });

  test("answers a second user message while the first script still runs", async () => {
    script(
      {
        match: "first",
        steps: [
          { emit: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } },
          { waitFor: "release" },
          { result: "first done" },
        ],
      },
      { steps: [{ result: "second done" }] },
    );
    const run = start();
    run.push(user("first"));
    await run.next((m) => m.type === "rate_limit_event");
    run.push(user("second"));

    await run.next(isResult("second done"));
    expect(run.messages.find(isResult("first done"))).toBeUndefined();
    writeFileSync(join(dir, "release"), "");
    await run.next(isResult("first done"));
    run.stop();
  });

  test("records user message flags and answers interrupt and stop_task", async () => {
    const run = start();
    run.push(user("hello"));
    const first = await run.next(isResult("ok"));
    run.push(user("nudge", { isSynthetic: true, priority: "now", origin: { kind: "human" } }));
    await run.next((m) => m.type === "result" && m !== first);
    await run.q.stopTask("t1");
    await run.q.interrupt();

    expect(lines("messages.jsonl")).toEqual([
      { sessionId: expect.any(String), text: "hello" },
      {
        sessionId: expect.any(String),
        text: "nudge",
        isSynthetic: true,
        priority: "now",
        origin: { kind: "human" },
      },
    ]);
    expect(lines("controls.jsonl")).toMatchObject([
      { subtype: "stop_task", task_id: "t1" },
      { subtype: "interrupt" },
    ]);
    run.stop();
  });

  test("a script can end the process, and a relaunch takes the next unused script", async () => {
    script(
      {
        steps: [
          { emit: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } },
          { exit: 3 },
        ],
      },
      { steps: [{ result: "after {session}" }] },
    );
    const first = start({ sessionId: "11111111-1111-4111-8111-111111111111" });
    first.push(user("one"));
    expect(await first.ended).toContain("exited with code 3");
    expect(first.messages.some((m) => m.type === "rate_limit_event")).toBe(true);
    first.stop();

    const second = start({ resume: "11111111-1111-4111-8111-111111111111" });
    second.push(user("two"));
    await second.next(isResult("after 11111111-1111-4111-8111-111111111111"));
    second.stop();
    expect(lines("messages.jsonl").map((l) => l.text)).toEqual(["one", "two"]);
  });
});
