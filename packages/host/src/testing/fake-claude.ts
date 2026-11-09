#!/usr/bin/env bun
// Fake Claude Code speaking just enough of the stream-json control protocol for a Thread turn. Point `cli.path` at this file, or at a wrapper script that passes the directory below as its first argument, which keeps the host's environment out of the fake's.
// The directory comes from FAKE_CLAUDE_DIR, or else from the first argument. It holds: `messages.jsonl` (one line per user message received: `{ sessionId, text }`, the session taken from the CLI's argv) and an optional `hold` file:
// while it exists, a received user message is not answered, which keeps the turn running. An optional `result.txt` is the text each turn answers with (default "ok").
// An optional `remember.json` (`{ scope, line }`) makes each user message call the host's in-process `remember` tool over the control protocol before the turn is answered. An optional `ask.json` (`{ question, options?, event_id?, linkDelivered?, afterHold?, crash? }`) does the same with `ask_user`; `linkDelivered` makes the call pass the id of the external event wrapped in the message it answers, as a bot following the host's instructions would, `afterHold` makes the calls (and the file's content they use) wait until `hold` is gone, and `crash` makes the process exit shortly after calling, with the question unanswered.
// A turn is answered only once every tool it called has its result, as with the real CLI: a pending `ask_user` keeps the turn running.
// Every tool result the host sends back for those calls is appended to `tool-results.jsonl` as the MCP response message.
// `auth status` prints the real CLI's JSON and exits 1 while a `signed-out` file exists, else exits 0. `auth login` exits with the code in the optional `login-exit` file (default 0).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
// `controls.jsonl` gets one line per `set_model` or `apply_flag_settings` control request the host sends: `{ subtype, model?, settings? }`, which is how a test sees the effort and model changes that are not on the command line.
// `launches.jsonl` gets one line per CLI launch: `{ cwd, appendSystemPrompt, mcpServers, env, argv }`. `argv` is the command line the CLI was started with, where the SDK puts `--settings` (the sandbox) and `--disallowedTools`. The servers are read from the --mcp-config file at startup, before the host removes it; the prompt arrives in the initialize request; `env` is the whole environment the CLI started with.
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ??
  process.argv[process.argv.indexOf(name) + 1];
const has = (name: string) => process.argv.some((a) => a === name || a.startsWith(`${name}=`));
const mcpFile = has("--mcp-config") ? arg("--mcp-config") : undefined;
const mcpServers =
  mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers : {};
// The SDK names the session on argv (`--session-id` for a new one, `--resume` for an existing one), not on each user message.
const session = has("--session-id")
  ? arg("--session-id")
  : has("--resume")
    ? arg("--resume")
    : "fake";
const out = (m: unknown) => console.log(JSON.stringify(m));
const hostMcp = (message: object) =>
  out({
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype: "mcp_message", server_name: "host", message },
  });

/** Tool results received so far, over every turn. */
let results = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request?.subtype === "initialize")
      appendFileSync(
        join(dir, "launches.jsonl"),
        JSON.stringify({
          cwd: process.cwd(),
          appendSystemPrompt: m.request.appendSystemPrompt,
          mcpServers,
          env: process.env,
          argv: process.argv.slice(envDir ? 2 : 3),
        }) + "\n",
      );
    if (m.request?.subtype === "set_model" || m.request?.subtype === "apply_flag_settings")
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
      appendFileSync(
        join(dir, "messages.jsonl"),
        JSON.stringify({ sessionId: session, text }) + "\n",
      );
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
      // Like the real CLI, the turn ends only once every tool it called has its result.
      while (results < done + called) await Bun.sleep(25);
      out({
        type: "result",
        subtype: "success",
        is_error: false,
        result: existsSync(join(dir, "result.txt"))
          ? readFileSync(join(dir, "result.txt"), "utf8")
          : "ok",
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
    })();
  } else if (m.type === "control_response") {
    const message = m.response?.response?.mcp_response;
    if (message?.id >= 2) {
      appendFileSync(join(dir, "tool-results.jsonl"), JSON.stringify(message) + "\n");
      results++;
    }
  }
}
