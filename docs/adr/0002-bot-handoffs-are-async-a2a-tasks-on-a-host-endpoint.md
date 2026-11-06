# 0002: Bot handoffs are asynchronous A2A-shaped tasks on a host-owned endpoint

Status: proposed

## Context

Bots have distinct purposes and sometimes need each other's help. Claudebot runs bots on Claude Code today, and Codex and OpenCode are planned. Each bot runs one turn at a time in one session, and the host already delivers its own messages into a bot's session through a queue (`deliver()`), which human waits use to resume a bot without holding a tool call open.

## Decision

A bot asks another bot for help by creating a handoff: a task with an id, a brief, messages and a status, modelled on A2A (agent card, task, message, artifact, A2A task states). Handoff tools are served by a host-owned Streamable HTTP MCP endpoint keyed by a per-session bearer token, like the browser endpoint (ADR-0001). Every handoff tool returns at once; the other party learns of each event through a host message delivered into its main session, and the requester gets the result the same way. The host stores handoffs in SQLite and enforces the rules (no cycles, depth and fan-out limits, role checks) in the endpoint.

## Alternatives considered

- **Blocking subagent-style call.** The requester's tool call waits for the assignee's result. Rejected: a bot runs one turn at a time, so A waiting on B while B asks A deadlocks, and long work hits harness tool-call timeouts.
- **In-process tools on the Claude Code `host` server.** Rejected for the same reason as in ADR-0001: each new harness would need its own copy.
- **A2A JSON-RPC between bots now.** Each bot as an A2A server with its own HTTP endpoint and agent card. Deferred: every bot lives in one host process, and bots call tools, not HTTP clients. Keeping A2A's data model makes exposing it later a translation layer, not a redesign.
- **Shared task board that bots claim from.** Deferred: it suits teams of interchangeable workers; claudebot bots have distinct purposes, so a directed request matches better.

## Consequences

- Adding a harness needs no handoff-specific work beyond the existing MCP adapter.
- A requester never has the answer within the turn that asked; bots must be told to report the handoff and stop or continue with independent work.
- Handoff turns run in the assignee's main session, so they share its context with the user's own conversation with that bot.
- The in-memory inbox is not durable, so the host re-delivers open handoffs on startup and bots may occasionally see a duplicate.
