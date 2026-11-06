# 0001: Browser engine behind a host-owned, harness-neutral MCP endpoint

Status: accepted

## Context

Bots can drive a real Chrome through the `agent-browser` engine. Claudebot runs bots on Claude Code today, and Codex and OpenCode are planned. The bot is untrusted for secrets: a prompt-injected page or bot must not be able to read saved logins, steal vault passwords, reach claudebot's own server through the browser, or drive the engine around claudebot's rules (policy, takeover lock, one call at a time, output limits, credential approval).

## Decision

The engine is wrapped by the host. Bots reach it only through a Streamable HTTP MCP route on the host server, bound to `127.0.0.1`, serving claudebot's own `browser_*` tools. All rules are enforced inside that endpoint, keyed by a per-session bearer token (issued per opened bot session, in memory only, revoked on session end). The endpoint rejects requests with an `Origin` header or a wrong `Host`. A small `Harness` adapter renders the endpoint's URL and token into each harness's MCP config; harness permission hooks only mirror the rules for UI polish. The host drives the engine itself by running its CLI with `--json` and host-fixed flags; bots get no direct path to it, enforced for Claude by the Claude Code sandbox for shell commands.

## Alternatives considered

- **Claude-only hooks or in-process tools.** Enforce the rules in `canUseTool` and the in-process tool server. Rejected: every new harness would need the whole security model re-implemented in its own permission system, and a hook bug would be a policy bypass. In-process tools stay for `ask_user`, `remember` and `rewrite_memory` only.
- **Direct engine CLI access for bots.** Let the bot's shell run `agent-browser`. Rejected: no takeover lock, no credential isolation, and the engine's dangerous features (eval, upload, state export) would be reachable.
- **The daemon's loopback relay.** Talk to the engine daemon's undocumented relay instead of its CLI. Rejected: undocumented and unstable; the `--json` CLI is the supported contract.

## Consequences

- Adding a harness means one adapter plus an equivalent isolation profile, with no browser-side changes.
- Without an isolation profile a harness cannot enable the browser; if the sandbox cannot start the switch is unavailable, never silently unprotected.
- Human waits (takeover, credential approval) return immediately and resume the bot with a message, so no harness tool-call timeout is involved.
- The host owns engine process hygiene and is a single point that must stay correct: token checks, Host/Origin checks and the egress proxy are part of the trust boundary.
- Engine per-call state cannot rely on process environment (the daemon fixes it at start), so per-call secrets such as the login nonce travel as arguments.

## Note: the agent listener

The loopback endpoint this ADR describes is now the **agent listener**: a second socket on `127.0.0.1` with its own free port, separate from the **client listener** that serves the web UI and `/api/*`. The browser endpoint, the bots endpoint and the credential exchange are served only there, and the client listener answers 404 for them. The checks above (Host, no Origin, per-session bearer token) are unchanged, and each harness's MCP config points at the agent listener. [ADR-0005](0005-agent-and-client-listeners-and-device-auth.md) records why the two listeners stay separate.
