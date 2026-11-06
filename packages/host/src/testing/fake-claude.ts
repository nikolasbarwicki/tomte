#!/usr/bin/env bun
// Fake Claude Code speaking just enough of the stream-json control protocol for a Thread turn. Point `cli.path` at this file.
// FAKE_CLAUDE_DIR holds: `messages.jsonl` (one line per user message received: `{ sessionId, text }`, the session taken from the CLI's argv) and an optional `hold` file:
// while it exists, a received user message is not answered, which keeps the turn running. An optional `result.txt` is the text each turn answers with (default "ok").
// An optional `remember.json` (`{ scope, line }`) makes each user message call the host's in-process `remember` tool over the control protocol before the turn is answered.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_CLAUDE_DIR;
if (!dir) process.exit(2);
// `launches.jsonl` gets one line per CLI launch: `{ cwd, appendSystemPrompt, mcpServers }`. The servers are read from the --mcp-config file at startup, before the host removes it; the prompt arrives in the initialize request.
const arg = (name: string) => process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? process.argv[process.argv.indexOf(name) + 1];
const has = (name: string) => process.argv.some((a) => a === name || a.startsWith(`${name}=`));
const mcpFile = has("--mcp-config") ? arg("--mcp-config") : undefined;
const mcpServers = mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers : {};
// The SDK names the session on argv (`--session-id` for a new one, `--resume` for an existing one), not on each user message.
const session = has("--session-id") ? arg("--session-id") : has("--resume") ? arg("--resume") : "fake";
const out = (m: unknown) => console.log(JSON.stringify(m));
const hostMcp = (message: object) => out({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "mcp_message", server_name: "host", message } });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request?.subtype === "initialize") appendFileSync(join(dir, "launches.jsonl"), JSON.stringify({ cwd: process.cwd(), appendSystemPrompt: m.request.appendSystemPrompt, mcpServers }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [], mcpServers: [], account: {}, totalTokens: 1000, rawMaxTokens: 200000, percentage: 1 } } });
  } else if (m.type === "user") {
    const text = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
    appendFileSync(join(dir, "messages.jsonl"), JSON.stringify({ sessionId: session, text }) + "\n");
    if (existsSync(join(dir, "remember.json"))) {
      hostMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } } });
      hostMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      hostMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: JSON.parse(readFileSync(join(dir, "remember.json"), "utf8")) } });
    }
    while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: existsSync(join(dir, "result.txt")) ? readFileSync(join(dir, "result.txt"), "utf8") : "ok",
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
  }
}
