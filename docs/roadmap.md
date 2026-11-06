# Roadmap

Source: competitor review of Rerun, OpenBot, Turnstone, Rakazo and MausBot against the codebase on 2026-11-06. Competitor facts come from their landing pages and public READMEs (Turnstone and MausBot: landing page only). "Claudebot lacks X" means no code for X was found.

Out of scope here: computer use (see [`research/cua-research.md`](research/cua-research.md)) and bot handoffs (see `.scratch/bot-handoffs/`). Both are tracked separately. Items 7 and 8 depend on handoffs landing, as does the Chief of Staff template in item 3.

## Where claudebot stands

Ahead of every competitor on safety: per-bot credential grants in a keychain-backed vault, an egress proxy and shell sandbox for the browser, per-tool `off/ask/auto` policies on integrations, takeover and human waits, and untrusted-content wrapping. OpenBot runs `danger-full-access` with `approvalPolicy: never` per its README.

Behind on everything around the bot: unattended approvals, event triggers, reach beyond one localhost tab, model providers, and bot authoring.

## Priorities

| # | Item | Why now |
|---|---|---|
| 1 | Approvals that park an unattended run | Routines cannot use any default-policy integration tool today |
| 2 | Event triggers (webhook first) ([research](research/webhook-research.md)) | Turns a bot from a cron job into an employee |
| 3 | Bot-facing tools to create routines, bots and skills | Prerequisite for a Chief of Staff bot |
| 4 | Second harness (Codex) and per-bot model choice | Every competitor sells "bring your own plan" |
| 5 | Remote access, one chat channel, always-on hosting | Approvals and routines are useless away from the desk |
| 6 | Small items: queue, templates, bot edit/delete, usage, catalog ([Google OAuth research](research/google-oauth-research.md)) | Cheap, each fixes a concrete gap |
| 7 | Expose bots over A2A or MCP to external agents | Handoffs are already A2A-shaped |
| 8 | Bot-authored skills | OpenBot has it; depends on item 3 |

Items 1 and 2 come first because they extend the safety advantage into unattended work, where competitors are weakest.

## 1. Approvals that park an unattended run

**Problem.** In `src/thread.ts`, `canUseTool` sends `ask`-policy integration tools to `delegate.approve` before it checks `approveAll`. `headlessDelegate.approve` in `src/routines.ts` always denies. `ask` is the default policy (`src/integrations.ts`), so a scheduled run cannot use any tool the user left at its default. A routine that must send an email fails.

**Competitors.** Rerun: coworkers stop before consequential actions, any teammate can answer, the run resumes where it stopped, and rules can answer on the user's behalf. Rakazo: Never ask / Auto / Ask modes with Allow and Block lists that grow from approval cards; a blocked action is refused without a card.

**Plan.**
- Add a `waiting` run status. A headless approval creates a wait (reuse the existing `wait` / `wait_resolved` events and `human-waits.ts`), pushes a `Notice`, and ends the run's turn.
- On approval, resume the run through `deliver()` into the bot's session. On deny, tell the bot and let it finish.
- Add Allow and Block lists per tool, fed from approval cards, so repeated approvals become rules.
- Auto-expire a wait after a fixed time, as takeover does (30 minutes).

**Decisions needed.**
- Resume in the same turn or as a new message. ADR-0002 already commits to "tools return at once, events arrive as messages"; follow it.
- Whether to add an approval model (Rakazo's Auto mode) or stay with static lists. Start with lists.

**Done when.** A routine calls an `ask`-policy tool, the run shows as waiting, the user approves from the UI, and the run completes without re-running earlier steps.

## 2. Event triggers

**Problem.** `RunTrigger` is `schedule | manual` (`web/events.ts`). Rerun, Rakazo and MausBot list webhooks and app-event triggers.

Research and plan: [`research/webhook-research.md`](research/webhook-research.md).

**Plan.**
- Add a `webhook` trigger: a per-routine secret URL on the host that fires the routine with the request body passed in as data.
- Later: a poller for Gmail and GitHub changes, built on the integration clients already connected.
- Copy Rakazo's rule: writes in webhook-started runs still ask, because outside text can steer the bot. Treat the payload like page content (untrusted, wrapped). This depends on item 1 and applies even in a bot's most permissive policy.

**Decisions needed.**
- The host binds to `127.0.0.1`. A webhook needs a tunnel or relay. Pick one before building (documented tunnel recipe vs. a hosted relay). Tied to item 5.
- Dedupe and replay: a webhook fired twice must not run twice. `fire()` cannot be reused for this: `claimOccurrence` in `src/routines-store.ts` dedupes on the schedule timestamp (`last_scheduled_for`), and a webhook has none. Needs its own key, for example a per-request id or a hash of the payload with a short window, stored with the run, and a decision on what a sender that cannot supply an id gets.

**Done when.** `curl` on the routine's URL starts a headless run with the payload visible to the bot, and a write inside it parks for approval.

## 3. Bots that create routines, bots and skills

**Problem.** The only bot-facing host tools on `master` are `ask_user` and `remember`. Routine CRUD exists only under `/api/routines/*`. MausBot ("automations from one sentence"), Rerun (Foreman), Turnstone and Rakazo (Chief of Staff) all let a bot set these up.

**Plan.**
- Add `create_routine` / `list_routines` / `update_routine` host tools, calling the same code as the HTTP routes.
- Add `create_bot` (name, purpose, initial memory). Pair it with the unfinished bot delete flow (item 6) so created bots can be cleaned up.
- Ship a Chief of Staff template that combines these with `hand_off`. This part waits for handoffs to land; `create_routine` and `create_bot` do not.

**Guards.** A bot may edit only its own routines. Cap the number of bots one bot may create. Bot-created routines default to approval-required for writes (item 1).

**Done when.** The user says "brief me every weekday at 8" in chat and a routine appears in the Routines panel without touching the UI.

## 4. Second harness and model choice

**Problem.** Claude Code is the only harness. `Harness` in `src/harness.ts` is the seam; the handoff endpoint is already harness-neutral. Every competitor offers several providers; OpenBot also moves a bot to a backup provider on a plan limit.

**Plan.**
- Implement a Codex harness behind the existing `Harness` interface.
- Per-bot harness and model, switchable mid-conversation without losing memory or files.
- Fallback provider on rate limit or outage, with a note in the chat. Routines are the likeliest to hit limits unattended.

**Risk to settle first.** `src/host.ts` already warns that a stored Claude login is "not valid for third-party products". Competitors market subscription sign-in anyway. Read the provider terms and decide the supported auth path before designing around it. OpenBot ships `docs/provider-terms.md` for this.

**Open question.** Session history is Claude Code's session chain (`bot.sessions`). A second harness needs a decision on what carries across: memory and files only, or a summarised transcript.

## 5. Remote access, a chat channel, always-on hosting

**Problem.** The UI is loopback-only with no auth, and the host is a manual `bun src/host.ts`. Rerun is a PWA, OpenBot has iOS and Android apps, Rakazo adds Slack, WhatsApp, Telegram and iMessage. Approvals (item 1) and routines only help if the user can answer them away from the desk.

**Plan, in order.**
1. Authenticated remote access to the existing UI (tunnel or reverse proxy, with a login). Keep the loopback endpoints for bot tools untouched.
2. One chat channel (Slack or Telegram) that posts bot messages, approval cards and `Notice`s, and routes replies into `deliver()`.
3. A service wrapper (launchd, systemd) or Docker image so the host stays up. Update docs.

**Constraint.** Never expose the browser, bots or credential endpoints without the existing token, Host and Origin checks.

## 6. Small items

Each is independent and fits in one PR. Order within the section is by user-visible pain.

### 6a. Message queue while busy

**Problem.** `/api/send` in `src/host-server.ts` returns 409 when `chat.busy` or a headless routine run holds the bot. The user must wait and retype.

**Plan.**
- On busy, push the text onto `chat.inbox` instead of rejecting. `drain()` already starts the next turn from the inbox once the bot is free and no headless run holds it, and already merges several texts into one turn.
- Show queued messages in the transcript as pending, with a cancel button that removes the entry from `chat.inbox` while it has not drained.
- Mentions resolve at send time, as now; store the resolved text, not the raw input.
- Later: "steer", which pushes into the live SDK `Inbox` in `src/thread.ts` mid-turn, and "pause". Both need SDK behaviour checked first.

**Decision needed.** The inbox mixes user messages with host messages (human-wait outcomes, handoff updates). Either tag entries by source so cancel only touches user ones, or keep a separate user queue drained ahead of the inbox. Tagging is less code.

**Done when.** Sending during a running turn shows the message as queued, it runs as the next turn, and cancelling it before then means it never reaches the bot.

### 6b. Bot templates

**Problem.** The create form (`NewBot` in `web/main.tsx`) takes a name and a free-text purpose. `createBot` in `src/bots.ts` stores only these; `memory.md` starts empty. A new user faces a blank box.

**Plan.**
- A static template list in the web bundle: name, purpose, memory seed, suggested integrations. Start with Inbox Manager, Coding Agent, Researcher.
- Picking one fills the form; the user can still edit. `/api/bots/new` gains an optional `memory` field written to `botMemoryPath`.
- Suggested integrations are shown as hints, not granted. Grants stay a user action.
- Chief of Staff joins once item 3 and handoffs land.

**Done when.** Choosing Inbox Manager creates a bot whose first turn already knows its job and memory seed.

### 6c. Bot edit and delete

**Problem.** No edit route or UI. `HostServer.removeBot` exists and calls `removeBotBrowser` and `removeBotHandoffs`, but nothing calls it outside tests, and it leaves the bot's directory, routines and chat state alone (`src/handoffs/cleanup.ts`: "Claudebot has no bot-delete path yet").

**Plan.**
- Edit: `/api/bots/update` for name and purpose. `openThread` snapshots both into the `Thread` through `botContext`, so `configStale` and `thread.close()` are not enough: a reopened thread keeps the old persona. Save the bot, update `chat.bot`, then replace `chat.thread` with `openThread(chat.bot, true, ...)` as `/api/session/new` does. If a turn is running, defer the swap to turn end with its own flag beside `configStale`.
- Delete: `/api/bots/delete` that refuses while a turn or headless run is active, then calls `removeBot`, deletes the bot's routines, closes and drops its `Chat`, and removes the bot directory.
- UI: edit and delete in the bot header; delete asks for confirmation naming what goes (memory, files, routines, open handoffs).

**Decision needed.** Hard delete or move the bot directory to a trash folder. Trash is safer for `files/`; pick it unless disk use is a concern.

**Done when.** Deleting a bot with an open handoff, a credential grant and a routine leaves none of them behind, and the other bot is told the handoff failed.

### 6d. Usage and cost

**Problem.** The SDK `result` message carries `total_cost_usd` and `usage`; the host drops them. Handoff guards limit counts, not spend.

**Plan.**
- Record cost and token usage per turn, keyed by bot and, when set, by routine run or handoff id.
- Show cost on each run in the Routines panel and on handoff cards, plus a per-bot total for the current month.
- No budgets or caps here; that is a separate decision once numbers exist.

**Caveat.** On a subscription login `total_cost_usd` is an API-price estimate, not a bill. Label it "estimated".

**Done when.** A routine run and a handoff each show a cost, and the bot's monthly total equals the sum of its turns.

### 6e. Bigger catalog

**Problem.** `CatalogEntry` in `src/integrations-catalog.ts` is data-only, so each new service is an entry, not code. The list is short. Google service setup for a public release: [`research/google-oauth-research.md`](research/google-oauth-research.md).

**Plan.**
- Add Slack, Notion, Google Calendar, Google Drive, Stripe, each with default `ask` policies on write tools.
- Spike Composio's MCP endpoint against the existing OAuth and bearer flows. If it fits, one entry covers thousands of apps; if its auth model needs a new code path, drop it. Unverified until tried.

**Done when.** Each new entry connects from the UI and one read and one write tool works from a bot, the write asking for approval.

## 7. Expose bots to external agents

ADR-0002 deferred "A2A JSON-RPC between bots" and "exposing bots as A2A servers". After handoffs land, add a translation layer from the handoff store to A2A, and an MCP tool surface for external agents. One OpenMausBot contributor merged an MCP server for external orchestration, so there is demand. Needs token issuance for external callers and the same untrusted-content rule as bot-to-bot messages.

## 8. Bot-authored skills

OpenBot lets agents create, revise and install local skills with versioning. Claudebot only imports skills from an integration's git repo. After item 3, add `create_skill` / `revise_skill` for skills scoped to one bot, with revisions retained.

## Deferred

- **Voice** (Rerun, Rakazo, MausBot). High cost; not tied to a current gap.
- **Multi-user teams and a template marketplace.** Conflicts with local-first, single-user.
- **Group channels where the user sits inside bot conversations** (OpenBot, Rakazo). Revisit if handoff cards prove insufficient.
- **A Turnstone-style "Brain"** that reads connected apps on a schedule and learns the user's writing voice. Needs the catalog from item 6 first.
- **Native desktop and mobile apps.** Revisit after item 5 shows whether a PWA is enough.
