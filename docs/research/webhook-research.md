# Webhook triggers: research

Roadmap item 2. Researched 2026-11-06 against the codebase. Cloudflare quick-tunnel facts are verified against [Cloudflare's Quick Tunnels doc](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) (updated 2026-09-30). The ngrok free-tier static-domain claim is unchecked.

## Findings in the code

| Fact | Evidence | Consequence |
|---|---|---|
| Host binds loopback only | `host-server/index.ts` | A public webhook needs a tunnel, relay or reverse proxy |
| UI, browser and bots endpoints check Host (most also Origin) | `ui-guard.ts:25`, `host-mcp/index.ts` | Hooks need their own listener; do not loosen these checks |
| Headless runs approve all by default | `routines/index.ts:70` `approveAll: process.env.CLAUDEBOT_ASK_APPROVAL !== "1"` | A payload can act unless a gate overrides this |
| Host, browser and bots tools skip all policy | `bots/thread.ts:144` | `remember`, `rewrite_memory`, browser and handoffs are reachable from a payload |
| Integration `auto` is allowed before `approveAll` | `bots/thread.ts:145-147` | A taint placed at `approveAll` is too late |
| In-root reads and writes are always allowed | `bots/thread.ts:155-156` | A payload can rewrite the bot's files |
| `trigger` has a CHECK constraint | `platform/db.ts:22` `CHECK (trigger IN ('schedule','manual'))` | Needs a table rebuild in a new `SCHEMA_Vn`; SQLite cannot alter a CHECK |
| One live run per routine id | `routines/index.ts:213,226` | Calling `run()` while busy clobbers the in-flight run; `testRun` throws `Conflict`, `fire` skips |
| Startup interrupts all `running` rows | `routines/store.ts:150-153` `interruptStaleRuns` | A persisted queue needs a separate `queued` status |
| Schedule dedupe is timestamp-based | `routines/store.ts:103` `claimOccurrence` | Webhooks need their own dedupe key |
| `UNIQUE (routine_id, scheduled_for)` | `platform/db.ts` | Allows any number of rows with NULL `scheduled_for`; no conflict for webhook rows |
| CLI is required even with an API key | `server.ts:14-16` exits when `resolveCli()` is null | A VPS needs the CLI binary (`CLAUDE_PATH` or `install-cli`) plus `ANTHROPIC_API_KEY` |
| Secrets are keychain-only | `platform/secrets.ts`, wired in `server.ts:25` (`Bun.secrets`, service `claudebot`); `memorySecrets` is in-process | On headless Linux without Secret Service, integration tokens, credential passwords and the browser engine key (`runtime.ts` `engineKey`) fail |

## Plan

0. **Untrusted-run gate. Ship before any copyable URL.**
   - Add `untrusted: true` to `ThreadOptions`, checked in `canUseTool` before every existing allow.
   - Allow read-only tools only.
   - Ask for everything else: Bash, in-root Write/Edit, `mcp__host__remember`/`rewrite_memory`, `mcp__browser__*`, `mcp__bots__*`, `auto` integration tools. Ignore `approveAll`.
   - Audit host tools one by one (`ask_user` can stay allowed).
   - Until roadmap item 1 lands, a headless ask is denied, so webhook runs are read-only.
   - Test: an untrusted thread with `approveAll: true` denies Bash, an in-root Write, `remember`, and an `auto` integration tool.
1. **Schema (`SCHEMA_Vn`).**
   - Rebuild `routine_runs` in one transaction: `trigger` adds `webhook`, `status` adds `queued`.
   - Add `dedupe_key`, `payload`, and `routines.webhook_secret`.
   - Dedupe keys are namespaced:
     - `id:<Idempotency-Key | X-GitHub-Delivery>` is permanent, via a partial unique index `WHERE dedupe_key LIKE 'id:%'`.
     - `hash:<sha256>` is a lookup only, with `started_at` inside a 10-minute window. No UNIQUE on it.
   - Test: old rows survive migration.
2. **Queue.**
   - The receiver inserts a `queued` row and returns 202 with the run id.
   - A per-routine drain starts the next row only after `entry.done`.
   - `queued` survives restart because `interruptStaleRuns` touches only `running`.
   - Bounded per routine (about 20). Beyond that return 429, and senders retry. A single slot would drop the rest of a burst.
3. **Payload.**
   - Verify the sender signature on the raw body before JSON parse (`X-Hub-Signature-256`, `Stripe-Signature`). Tunnel providers see the URL and body, and GitHub stores the URL, so the path secret is only a fallback for senders that cannot sign.
   - Accept up to a high abuse limit; do not 413 small (GitHub disables hooks after repeated failures).
   - Cap only what enters the prompt, spilling the rest to a file like `shapePage`.
   - Wrap the payload as untrusted content and run with `untrusted: true`.
4. **Receiver.**
   - Separate listener bound to `127.0.0.1`, serving only `POST /hooks/<routineId>/<secret>`, with a constant-time compare.
   - No Host check on it (tunnels rewrite Host). That is safe only because it is loopback-bound and serves nothing else; `0.0.0.0` would expose it on the LAN.
   - Never mount `/hooks` on the UI server: a tunnel pointed at the wrong port then still fails the UI's Host/Origin checks.
5. **UI and docs.**
   - Copyable URL, rotate button, a "public base URL" setting, and `queued` rows shown in the Routines panel.

Before item 1: webhook routines can read, summarize and notify, and writes are refused with a reason. After item 1: writes park for approval and resume when approved.

## Exposure for open-source users

| Option | User effort | Maintainer cost | Verdict |
|---|---|---|---|
| A. Bring your own tunnel | Run a tunnel, paste the URL in settings | Docs | Ship first |
| B. Built-in launcher | One click; spawns `cloudflared tunnel --url http://127.0.0.1:<hooksPort>` and parses the `trycloudflare.com` URL | Wrapper around a binary | Ship next |
| C. Hosted relay | None | A service, auth, abuse handling, uptime | Only on proven demand; make it self-hostable |
| D. Pollers (Gmail, GitHub) | None | Per-integration code | Covers common cases with no inbound traffic |

Account requirements:

| Tunnel | Account | URL |
|---|---|---|
| cloudflared quick tunnel | None | Random, changes on restart |
| cloudflared named tunnel | Free Cloudflare account and a domain on Cloudflare | Stable |
| ngrok | Required (authtoken from the dashboard) | Random; static free-tier domain unchecked |
| Tailscale Funnel | Tailscale account | Stable `*.ts.net` |

Quick tunnels:
- No account or domain needed. Cloudflare labels them testing and development only, with no uptime guarantee.
- Up to 200 in-flight requests per tunnel; more return `429`. Senders that retry recover.
- The hostname changes each time a tunnel is created, and the URL stops working when `cloudflared` stops. Senders keep the old URL, so the launcher must show the current one and warn when it changes.
- No Server-Sent Events. The launcher must target only the hooks port, never the UI port (the UI's live updates would break, and the UI must not be public anyway).
- `--allowed-mail` (email one-time PIN) needs an interactive browser session, so it cannot protect webhook POSTs. Signatures and the path secret are the only protection.
- With A and B, traffic still passes through a third party even though the maintainer runs nothing, which is why signatures (step 3) matter.

## VPS deployment

A VPS removes the tunnel only. Steps 0–4 are still needed.

- Keep the host and hooks listener on `127.0.0.1`. Put Caddy (automatic TLS) in front, forwarding only `/hooks/*`:
  ```
  hooks.example.com {
    reverse_proxy /hooks/* 127.0.0.1:<hooksPort>
    respond 404
  }
  ```
- Reach the UI over `ssh -L` or Tailscale until roadmap item 5 adds a login.
- systemd unit (roadmap item 5, step 3).
- Install the CLI and set `ANTHROPIC_API_KEY`. Check provider terms before using a subscription login on a server (`src/host.ts` warning).
- A secrets backend for headless Linux is needed before integrations, credentials and the browser work there.
