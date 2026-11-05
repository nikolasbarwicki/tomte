#!/usr/bin/env bun
// Fake Claude Code speaking just enough of the stream-json control protocol for a Thread turn. Point `cli.path` at this file.
// FAKE_CLAUDE_DIR holds: `messages.jsonl` (one line per user message received, as text) and an optional `hold` file:
// while it exists, a received user message is not answered, which keeps the turn running. An optional `result.txt` is the text each turn answers with (default "ok").
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_CLAUDE_DIR;
if (!dir) process.exit(2);
const out = (m: unknown) => console.log(JSON.stringify(m));

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [], mcpServers: [], account: {}, totalTokens: 1000, rawMaxTokens: 200000, percentage: 1 } } });
  } else if (m.type === "user") {
    const text = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
    appendFileSync(join(dir, "messages.jsonl"), JSON.stringify(text) + "\n");
    while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: existsSync(join(dir, "result.txt")) ? readFileSync(join(dir, "result.txt"), "utf8") : "ok",
      session_id: m.session_id ?? "fake",
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
