# Threat model

What Tomte protects, from whom, and which mechanism does it. Each boundary links the ADR that records the decision. Report a way across any of them through [SECURITY.md](../SECURITY.md).

Status: written from the ADRs and the code on 2026-11-20. Where a claim was never run, it says so.

## Who is trusted

| Actor                                                              | Trust         | Why                                                                           |
| ------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------- |
| The owner, on a paired device                                      | Trusted       | Holds a device token; can do anything the UI can                              |
| The owner, on the host's file system                               | Trusted       | Can read the data root and the keychain; Tomte cannot defend against them     |
| A bot (a Claude CLI session)                                       | **Untrusted** | It reads web pages, email and files; any of that can carry a prompt injection |
| Content a bot reads (pages, messages, tool output, event payloads) | **Untrusted** | Wrapped and treated as data, never as instructions to the host                |
| Another web page in the owner's browser                            | Untrusted     | Can make cross-origin requests to loopback                                    |
| Another local process or user                                      | Untrusted     | Can connect to loopback ports                                                 |
| A stranger on Telegram                                             | Untrusted     | Anyone can message a bot's username                                           |
| Anyone who can reach a remote host's port                          | Untrusted     | Must pair before doing anything                                               |

## Assets

| Asset                                                                          | Where it lives                                                                                     | Guarded by                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Claude sign-in                                                                 | The CLI's own store: a file under `<data root>/claude` in remote mode, the login keychain on macOS | Sandbox deny-reads (Linux); see "Known gaps" for macOS               |
| Secrets store (channel token, event tokens, gateway token, integration tokens) | OS keychain, or `secrets.enc` with a key file                                                      | Sandbox deny-reads; never in the event stream, logs or API responses |
| Device tokens                                                                  | Only their SHA-256 digests in SQLite; the token is shown once                                      | Constant-time digest compare; revocation closes open streams         |
| Bots' files, memory, chats                                                     | The data root                                                                                      | Each bot's sandbox sees only its own folder                          |
| The owner's accounts behind integrations (Gmail, GitHub)                       | Integration tokens in the secrets store                                                            | Per-tool `off` / `ask` / `auto` policies                             |
| The host's machine                                                             |                                                                                                    | Shell sandbox, browser egress proxy, approvals                       |

## Trust boundaries

### 1. Bots versus the host: two listeners

The host opens an **agent listener** (loopback, a free port, bearer token per session) and a **client listener** (the UI and `/api/*`). A bot reaches only the first; the second's routes are not registered on it. The agent listener serves the MCP endpoints a bot needs (browser, bots, routines) and nothing else, rejects any `Origin` and any wrong `Host`. [ADR-0001](adr/0001-browser-engine-behind-host-mcp-endpoint.md), [ADR-0005](adr/0005-agent-and-client-listeners-and-device-auth.md).

### 2. Web pages and local processes versus the client API

Every request to the client listener passes `withBoundary` in this order: `Host` must be this host (stops DNS rebinding); a mutating request needs a matching `Origin` and `application/json` (stops cross-site forms and `text/plain` posts); then a device token is required. Exceptions are listed in ADR-0005 and are narrow: pairing, `host-info`, the OAuth callback, static assets and the event route. Device tokens are 32 random bytes, stored as digests; the session cookie is `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS. [ADR-0005](adr/0005-agent-and-client-listeners-and-device-auth.md).

### 3. Pairing a new device

A 12-character single-use code, stored as a digest, valid 10 minutes; ten failed attempts invalidate every outstanding code. A pairing page needs no setup route because `host pair` writes the database directly. [ADR-0005](adr/0005-agent-and-client-listeners-and-device-auth.md).

### 4. Remote mode and the Claude sign-in

In remote mode the sign-in is a file in a directory every bot's sandbox denies. Remote mode is refused except on Linux because on macOS the sign-in is in the keychain, which the sandbox profile can still ask. [ADR-0006](adr/0006-remote-mode-is-linux-only.md). Verified for Linux with bubblewrap in a container; the macOS keychain probe was never run.

### 5. The bot's shell and the browser

Bot shells run under Claude Code's sandbox with a host-built deny list (sign-in directory, secrets, key file, database, other bots' folders). The browser engine is reachable only through the host's endpoint: one call at a time, a takeover lock, output limits, and an egress proxy that keeps the browser away from the host's own listeners. A sign-in page needs a takeover by the owner; the credential vault was removed. [ADR-0001](adr/0001-browser-engine-behind-host-mcp-endpoint.md).

### 6. What a bot may do without asking

- **Per-tool policy** on every integration tool: `off`, `ask` or `auto`.
- **Always ask**: `mcp__bots__create_bot` is in `ALWAYS_ASK_TOOLS` and asks even when everything else is allowed or approved. It has no "always allow", and an unattended run is denied at once.
- **Unattended runs** park on a durable wait instead of acting: the run becomes `waiting`, the owner answers on the same cards, the run resumes in its session, and an unanswered park expires after 24 hours and fails. [ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md).
- **Content from outside** (browser page text and external event payloads) is wrapped as untrusted before the bot sees it.

What it does not do: Tomte does not stop a bot from doing something you approved, or something a tool set to `auto` allows. Prompt injection is a risk the approvals reduce; they do not remove it.

### 7. External events and the relay

`POST /api/bots/<id>/events` is authorised by a per-bot **event token** that can post events to that bot and nothing else, and can be rotated. [ADR-0007](adr/0007-external-events-route-and-event-token.md). An answer reaches a sender only through an adapter the operator configured in a local file, run by the host with an argv array and no shell; an event fills only bounded slots and never supplies a command. [ADR-0008](adr/0008-answer-relay-hook.md).

### 8. Telegram

One account is linked per channel through a one-time code. A message from anyone else gets no reply and changes nothing; only a code-shaped text is treated as a link attempt, and ten failures kill the channel's codes. The bot token is a secret in the secrets store; no route, event or log returns it. Button data is `<prefix>:<id>:<arg>` and indexes into stored actions, never carries text to execute. [ADR-0010](adr/0010-channels-deliver-needs-you-items.md).

### 9. The desktop app

The Electron main process runs no host code (enforced by `dependency-cruiser`); it spawns the host binary and passes a launch token on stdin. The window has context isolation and the sandbox on, no Node, no preload, and navigation pinned to the host's origin. Connection profiles keep their device token encrypted with `safeStorage` and refuse plaintext. [ADR-0005](adr/0005-agent-and-client-listeners-and-device-auth.md), [ADR-0003](adr/0003-feature-modules-and-dependency-rules.md).

### 10. Supply chain

Releases are built in GitHub Actions from a tag that must match `VERSION`; assets carry `SHA256SUMS`. macOS and Windows signing is implemented but has never run against real certificates, so current builds are unsigned. SBOM and provenance attestations are not in place yet.

## Known gaps

- **macOS remote sign-in**: unverified whether a sandboxed bot can ask the keychain for the Claude sign-in. Remote mode is therefore Linux only ([ADR-0006](adr/0006-remote-mode-is-linux-only.md)); on a Mac the sign-in is only as private as your login session.
- **Unsigned builds**: Gatekeeper and SmartScreen warn on first launch; macOS auto-update of an unsigned app is not expected to work.
- **Windows and Linux desktop installers** are built by CI and have never been run.
- **Plain HTTP**: a host exposed without HTTPS or Tailscale sends the session cookie in clear. The deploy kit sets up HTTPS; nothing forces you to use it.
- **Model behaviour**: a bot that follows an injected instruction can misuse any `auto` tool. Keep write tools at `ask`.
- **One owner**: there are no roles. Every paired device has full access; revoke devices you no longer use.
