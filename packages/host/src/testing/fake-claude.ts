#!/usr/bin/env bun
// Fake Claude Code speaking just enough of the stream-json control protocol for a Thread turn. Point `cli.path` at this file, or at a wrapper script that passes the directory below as its first argument, which keeps the host's environment out of the fake's.
// The directory comes from FAKE_CLAUDE_DIR, or else from the first argument. It holds: `messages.jsonl` (one line per user message received: `{ sessionId, text }`, plus the message's `isSynthetic`, `priority` and `origin` when it has them; the session taken from the CLI's argv) and an optional `hold` file:
// while it exists, a received user message is not answered, which keeps the turn running. An optional `result.txt` is the text each turn answers with (default "ok").
// An optional `remember.json` (`{ scope, line }`) makes each user message call the host's in-process `remember` tool over the control protocol before the turn is answered. An optional `ask.json` (`{ question, options?, event_id?, linkDelivered?, afterHold?, crash? }`) does the same with `ask_user`; `linkDelivered` makes the call pass the id of the external event wrapped in the message it answers, as a bot following the host's instructions would, `afterHold` makes the calls (and the file's content they use) wait until `hold` is gone, and `crash` makes the process exit shortly after calling, with the question unanswered.
// An optional `approve.json` (`{ tool, input? }`) makes each user message send a `can_use_tool` control request for that tool and input, as the CLI does when a tool call needs the host's permission, wait for the host's answer and append `{ tool_name, agent_id, response }` to `permission-results.jsonl` (`response` is `{ behavior: "allow" | "deny", ... }`, or `{ error }`). Like a pending `ask_user`, an approval keeps the turn running for as long as the user takes; the turn is answered once the host has answered.
// A turn is answered only once every tool it called has its result, as with the real CLI: a pending `ask_user` keeps the turn running.
// Every tool result the host sends back for those calls is appended to `tool-results.jsonl` as the MCP response message.
// `auth status` prints the real CLI's JSON and exits 1 while a `signed-out` file exists, else exits 0. `auth login` exits with the code in the optional `login-exit` file (default 0).
// An optional `loop.json` scripts what the fake emits per user message, to drive the host as the double-loop chat mode's long-lived front query does (background tasks, hooks, in-process MCP servers, a crash mid-run). Without it, or when no script is left for a message, the behaviour above is unchanged. Shape: `{ scripts: [{ match?: string, steps: Step[] }] }`.
// A user message takes the first unused script whose `match` is a substring of its text, else the first unused script without a `match`; the use is recorded in `loop-used.json`, so it holds across relaunches (`--resume`). Steps run in order, off the read loop, so a later user message is answered while an earlier script still runs. A script with no `result` step ends with the default result (`result.txt`, else "ok"). Every string in a step may hold `{session}` (the session id), `{n}` (0-based index of the user message over all launches, the line count of `messages.jsonl` before it) and `{queued}` (the first queue id, `q-` and hex digits, in the user message's text: the task the app asks the front to start).
// Steps (one key each):
// - `{ emit: <SDK message> }`: one stdout line; `session_id` and `uuid` are filled when missing. Use it for `system` `task_started` / `task_progress` / `task_notification`, `assistant` messages with `tool_use` blocks, `user` tool results, `rate_limit_event`.
// - `{ text: "..." }`: `stream_event` deltas (message_start, content_block_start, one content_block_delta per word, content_block_stop, message_delta, message_stop), then the matching `assistant` message.
// - `{ hook: "PreToolUse", input: {...}, tool_use_id?, ifDenied?: Step[] }`: sends a `hook_callback` control request to every callback id the initialize request registered for that event whose `matcher` (a regex against `tool_name`, else `agent_type`; none means all) matches, waits for the replies and appends one `{ hook, input, callback, response }` line per callback to `hook-results.jsonl` (`response` is the hook's output, or `{ error }`; `callback` is null, with a null `response`, when nothing is registered). `ifDenied` runs when a reply denies (`hookSpecificOutput.permissionDecision` "deny" or `decision` "block").
// - `{ canUseTool: { tool_name, input?, agent_id?, tool_use_id?, ifDenied?: Step[] } }`: sends a `can_use_tool` control request, as the CLI does when a tool call needs the host's permission (`agent_id` is the background agent making the call, as the CLI names it for a subagent's calls), waits for the host's answer and appends `{ tool_name, agent_id, response }` to `permission-results.jsonl` (`response` is the answer, `{ behavior: "allow" | "deny", ... }`, or `{ error }`). `ifDenied` runs when the host denies. The step waits for the answer, which for a user's approval card takes as long as the user does.
// - `{ mcp: { server, tool, args?, tool_use_id? } }`: calls the in-process SDK MCP server named `server` (initialized once per server and launch; `tool_use_id` goes in the request's `_meta["claudecode/toolUseId"]`, as the CLI names the tool use), waits for the result and appends `{ server, tool, ...<MCP response message> }` to `tool-results.jsonl`.
// - `{ result: "text" }`: emits the turn's `result` message; steps may follow (background work that reports after the turn).
// - `{ sleep: ms }`; `{ waitFor: "<file name>" }` polls until that file exists in the directory (a test sequences steps with it); `{ exit: code }` ends the process, as a crash.
// With a script run, the process also exits when stdin ends, instead of waiting for steps still running.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const envDir = process.env.FAKE_CLAUDE_DIR;
const dir = envDir ?? process.argv[2];
if (!dir) process.exit(2);
const [command, subcommand] = process.argv.slice(envDir ? 2 : 3);
if (command === "auth") {
  if (subcommand === "login")
    process.exit(
      existsSync(join(dir, "login-exit"))
        ? Number(readFileSync(join(dir, "login-exit"), "utf8"))
        : 0,
    );
  const signedIn = !existsSync(join(dir, "signed-out"));
  console.log(
    JSON.stringify({
      loggedIn: signedIn,
      authMethod: signedIn ? "claude.ai" : "none",
      configDirectory: process.env.CLAUDE_CONFIG_DIR,
    }),
  );
  process.exit(signedIn ? 0 : 1);
}
// `controls.jsonl` gets one line per `set_model`, `apply_flag_settings`, `interrupt` or `stop_task` control request the host sends: `{ subtype, model?, settings?, task_id? }`, which is how a test sees the effort and model changes that are not on the command line, an interrupt, and a task being stopped. Each is answered with a success `control_response`.
// `launches.jsonl` gets one line per CLI launch: `{ cwd, appendSystemPrompt, agents, mcpServers, env, argv }`. `argv` is the command line the CLI was started with, where the SDK puts `--settings` (the sandbox) and `--disallowedTools`. The servers are read from the --mcp-config file at startup, before the host removes it; the prompt and `agents` (the agent definitions, by name) arrive in the initialize request; `env` is the whole environment the CLI started with.
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ??
  process.argv[process.argv.indexOf(name) + 1];
const has = (name: string) => process.argv.some((a) => a === name || a.startsWith(`${name}=`));
const mcpFile = has("--mcp-config") ? arg("--mcp-config") : undefined;
const mcpServers =
  mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers : {};
// The SDK names the session on argv (`--session-id` for a new one, `--resume` for an existing one), not on each user message.
const session =
  (has("--session-id") ? arg("--session-id") : has("--resume") ? arg("--resume") : undefined) ??
  "fake";
const out = (m: unknown) => console.log(JSON.stringify(m));
const control = (request: object, requestId: string = crypto.randomUUID()) =>
  out({ type: "control_request", request_id: requestId, request });
const mcpControl = (server: string, message: object) =>
  control({ subtype: "mcp_message", server_name: server, message });
const hostMcp = (message: object) => mcpControl("host", message);

/** The `response` object of a control_response; its `response` is the reply's payload. */
type ControlReply = { subtype?: string; error?: string; response?: Record<string, unknown> };
/** Control requests the fake sent that wait for their response, by request id. */
const pending = new Map<string, (reply: ControlReply) => void>();
const ask = (request: object) => {
  const { promise, resolve } = Promise.withResolvers<ControlReply>();
  const id = crypto.randomUUID();
  pending.set(id, resolve);
  control(request, id);
  return promise;
};
/** What the initialize request registered: event name to `{ matcher?, hookCallbackIds }` entries. */
let hooks: Record<string, { matcher?: string; hookCallbackIds: string[] }[]> = {};

type Step = {
  emit?: Record<string, unknown>;
  text?: string;
  hook?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  ifDenied?: Step[];
  canUseTool?: {
    tool_name: string;
    input?: Record<string, unknown>;
    agent_id?: string;
    tool_use_id?: string;
    ifDenied?: Step[];
  };
  mcp?: { server: string; tool: string; args?: Record<string, unknown>; tool_use_id?: string };
  result?: string;
  sleep?: number;
  waitFor?: string;
  exit?: number;
};
type Script = { match?: string; steps: Step[] };

const record = (file: string, value: unknown) =>
  appendFileSync(join(dir, file), JSON.stringify(value) + "\n");
/** The values `{...}` in a step stand for. */
type Substitutions = { n: number; queued: string };
const subst = <T>(value: T, vars: Substitutions): T => {
  if (typeof value === "string")
    return value
      .replaceAll("{session}", session)
      .replaceAll("{n}", String(vars.n))
      .replaceAll("{queued}", vars.queued) as T;
  if (Array.isArray(value)) return value.map((v) => subst(v, vars)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, vars)])) as T;
  return value;
};
const resultMessage = (result: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  session_id: session,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: crypto.randomUUID(),
});
const defaultResult = () =>
  existsSync(join(dir, "result.txt")) ? readFileSync(join(dir, "result.txt"), "utf8") : "ok";

const usage = { input_tokens: 1, output_tokens: 1 };
const textMessages = (text: string) => {
  const id = `msg_${crypto.randomUUID()}`;
  const stream = (event: object) =>
    out({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: session,
    });
  stream({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [],
      stop_reason: null,
      usage,
    },
  });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const chunk of text.split(/(?<=\s)/).filter(Boolean))
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
  stream({ type: "content_block_stop", index: 0 });
  stream({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage,
  });
  stream({ type: "message_stop" });
  out({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage,
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: session,
  });
};

let rpcId = 0;
const handshakes = new Map<string, Promise<unknown>>();
const mcpCall = async (server: string, message: Record<string, unknown>) => {
  const reply = await ask({
    subtype: "mcp_message",
    server_name: server,
    message: { jsonrpc: "2.0", ...message },
  });
  return reply.response?.mcp_response as Record<string, unknown> | undefined;
};
const callTool = async (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  toolUseId?: string,
) => {
  if (!handshakes.has(server))
    handshakes.set(
      server,
      (async () => {
        await mcpCall(server, {
          id: ++rpcId,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "fake-claude", version: "0" },
          },
        });
        await mcpCall(server, { method: "notifications/initialized" });
      })(),
    );
  await handshakes.get(server);
  const response = await mcpCall(server, {
    id: ++rpcId,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
      ...(toolUseId !== undefined && { _meta: { "claudecode/toolUseId": toolUseId } }),
    },
  });
  record("tool-results.jsonl", { server, tool, ...response });
};

const matcherHits = (matcher: string | undefined, subject: string) => {
  if (matcher === undefined || matcher === "") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(subject);
  } catch {
    return matcher === subject;
  }
};
const denies = (r: unknown) => {
  const reply = r as { hookSpecificOutput?: { permissionDecision?: string }; decision?: string };
  return reply?.hookSpecificOutput?.permissionDecision === "deny" || reply?.decision === "block";
};

let ranScript = false;
/** Runs `steps`; true once a `result` step has emitted the turn's result. */
const runSteps = async (steps: Step[], vars: Substitutions): Promise<boolean> => {
  let answered = false;
  for (const raw of steps) {
    const step = subst(raw, vars);
    if (step.emit) {
      out({ session_id: session, uuid: crypto.randomUUID(), ...step.emit });
    } else if (step.text !== undefined) {
      textMessages(step.text);
    } else if (step.hook !== undefined) {
      const input: Record<string, unknown> = {
        hook_event_name: step.hook,
        session_id: session,
        transcript_path: "",
        cwd: process.cwd(),
        ...step.input,
      };
      const subject = [input.tool_name, input.agent_type].find((v) => typeof v === "string") ?? "";
      const callbacks = (hooks[step.hook] ?? [])
        .filter((h) => matcherHits(h.matcher, subject))
        .flatMap((h) => h.hookCallbackIds);
      const responses = await Promise.all(
        callbacks.map(async (callback) => {
          const reply = await ask({
            subtype: "hook_callback",
            callback_id: callback,
            input,
            ...(step.tool_use_id !== undefined && { tool_use_id: step.tool_use_id }),
          });
          const response =
            reply.subtype === "error" ? { error: reply.error } : (reply.response ?? null);
          record("hook-results.jsonl", { hook: step.hook, input, callback, response });
          return response;
        }),
      );
      if (!callbacks.length)
        record("hook-results.jsonl", { hook: step.hook, input, callback: null, response: null });
      if (step.ifDenied && responses.some(denies))
        answered = (await runSteps(step.ifDenied, vars)) || answered;
    } else if (step.canUseTool) {
      const { tool_name, input = {}, agent_id, tool_use_id, ifDenied } = step.canUseTool;
      const reply = await ask({
        subtype: "can_use_tool",
        tool_name,
        input,
        tool_use_id: tool_use_id ?? crypto.randomUUID(),
        ...(agent_id !== undefined && { agent_id }),
      });
      const response =
        reply.subtype === "error" ? { error: reply.error } : (reply.response ?? null);
      record("permission-results.jsonl", { tool_name, agent_id, response });
      if (ifDenied && (response as { behavior?: string } | null)?.behavior === "deny")
        answered = (await runSteps(ifDenied, vars)) || answered;
    } else if (step.mcp) {
      await callTool(step.mcp.server, step.mcp.tool, step.mcp.args ?? {}, step.mcp.tool_use_id);
    } else if (step.result !== undefined) {
      out(resultMessage(step.result));
      answered = true;
    } else if (step.sleep !== undefined) {
      await Bun.sleep(step.sleep);
    } else if (step.waitFor !== undefined) {
      while (!existsSync(join(dir, step.waitFor))) await Bun.sleep(10);
    } else if (step.exit !== undefined) {
      await Bun.sleep(50);
      process.exit(step.exit);
    }
  }
  return answered;
};

/** The script for a user message, marked used; none when `loop.json` is absent or exhausted. */
const takeScript = (text: string): Script | undefined => {
  const file = join(dir, "loop.json");
  if (!existsSync(file)) return undefined;
  const scripts: Script[] = JSON.parse(readFileSync(file, "utf8")).scripts ?? [];
  const usedFile = join(dir, "loop-used.json");
  const used: number[] = existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : [];
  const free = (i: number) => !used.includes(i);
  let index = scripts.findIndex(
    (s, i) => free(i) && s.match !== undefined && text.includes(s.match),
  );
  if (index < 0) index = scripts.findIndex((s, i) => free(i) && s.match === undefined);
  if (index < 0) return undefined;
  writeFileSync(usedFile, JSON.stringify([...used, index]));
  return scripts[index];
};

/** Tool results received so far, over every turn. */
let results = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request?.subtype === "initialize") {
      hooks = m.request.hooks ?? {};
      appendFileSync(
        join(dir, "launches.jsonl"),
        JSON.stringify({
          cwd: process.cwd(),
          appendSystemPrompt: m.request.appendSystemPrompt,
          agents: m.request.agents,
          mcpServers,
          env: process.env,
          argv: process.argv.slice(envDir ? 2 : 3),
        }) + "\n",
      );
    }
    if (["set_model", "apply_flag_settings", "interrupt", "stop_task"].includes(m.request?.subtype))
      appendFileSync(join(dir, "controls.jsonl"), JSON.stringify(m.request) + "\n");
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: m.request_id,
        response: {
          commands: [],
          models: [],
          mcpServers: [],
          account: {},
          totalTokens: 1000,
          rawMaxTokens: 200000,
          percentage: 1,
        },
      },
    });
  } else if (m.type === "user") {
    // Handled off the read loop, so tool results (the user's answers) are read while the turn waits for them.
    void (async () => {
      const text =
        typeof m.message.content === "string"
          ? m.message.content
          : JSON.stringify(m.message.content);
      const n = existsSync(join(dir, "messages.jsonl"))
        ? readFileSync(join(dir, "messages.jsonl"), "utf8").split("\n").length - 1
        : 0;
      appendFileSync(
        join(dir, "messages.jsonl"),
        JSON.stringify({
          sessionId: session,
          text,
          ...(m.isSynthetic !== undefined && { isSynthetic: m.isSynthetic }),
          ...(m.priority !== undefined && { priority: m.priority }),
          ...(m.origin !== undefined && { origin: m.origin }),
        }) + "\n",
      );
      const script = takeScript(text);
      if (script) {
        ranScript = true;
        const queued = /q-[0-9a-f]+/.exec(text)?.[0] ?? "";
        if (!(await runSteps(script.steps, { n, queued }))) out(resultMessage(defaultResult()));
        return;
      }
      const askFile = join(dir, "ask.json");
      const first = existsSync(askFile) ? JSON.parse(readFileSync(askFile, "utf8")) : {};
      const late = first.afterHold;
      const callTools = () => {
        const calls = (["remember", "ask_user"] as const).flatMap((name) => {
          const file = join(dir, name === "remember" ? "remember.json" : "ask.json");
          if (!existsSync(file)) return [];
          const {
            linkDelivered,
            afterHold: _hold,
            crash: _crash,
            ...args
          } = JSON.parse(readFileSync(file, "utf8"));
          const delivered = linkDelivered
            ? /<<<EXTERNAL_EVENT nonce=\S+ id=(\S+) /.exec(text)?.[1]
            : undefined;
          return [{ name, arguments: delivered ? { ...args, event_id: delivered } : args }];
        });
        if (!calls.length) return 0;
        hostMcp({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "fake-claude", version: "0" },
          },
        });
        hostMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
        calls.forEach((params, i) =>
          hostMcp({ jsonrpc: "2.0", id: 2 + i, method: "tools/call", params }),
        );
        return calls.length;
      };
      const done = results;
      let called = late ? 0 : callTools();
      while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
      if (first.crash) {
        await Bun.sleep(150);
        process.exit(1);
      }
      if (late) called = callTools();
      const approveFile = join(dir, "approve.json");
      if (existsSync(approveFile)) {
        const { tool, input } = JSON.parse(readFileSync(approveFile, "utf8"));
        await runSteps([{ canUseTool: { tool_name: tool, input: input ?? {} } }], {
          n,
          queued: "",
        });
      }
      // Like the real CLI, the turn ends only once every tool it called has its result.
      while (results < done + called) await Bun.sleep(25);
      out(resultMessage(defaultResult()));
    })();
  } else if (m.type === "control_response") {
    const waiting = pending.get(m.response?.request_id);
    if (waiting) {
      pending.delete(m.response.request_id);
      waiting(m.response);
      continue;
    }
    const message = m.response?.response?.mcp_response;
    if (message?.id >= 2) {
      appendFileSync(join(dir, "tool-results.jsonl"), JSON.stringify(message) + "\n");
      results++;
    }
  }
}
if (ranScript) process.exit(0);
