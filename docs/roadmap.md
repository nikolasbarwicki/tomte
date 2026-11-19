# Roadmap

Source: competitor review of Rerun, OpenBot, Turnstone, Rakazo and MausBot against the codebase on 2026-11-06. Competitor facts come from their landing pages and public READMEs (Turnstone and MausBot: landing page only). "Tomte lacks X" means no code for X was found.

Out of scope here: computer use (see [`research/cua-research.md`](research/cua-research.md)). Bot handoffs have landed (`packages/host/src/handoffs/`, ADR-0002) and are not tracked here. Items 7 and 8 build on them, as does the Chief of Staff, which is a switch on a bot (item 3).

## Where tomte stands

Ahead of every competitor on safety: an egress proxy and shell sandbox for the browser, per-tool `off/ask/auto` policies on integrations, takeover and human waits, and untrusted-content wrapping. OpenBot runs `danger-full-access` with `approvalPolicy: never` per its README.

Behind on everything around the bot: unattended approvals, event triggers, reach beyond one localhost tab, model providers, and bot authoring.

## Priorities

| #   | Item                                                                                                                        | Why now                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Approvals that park an unattended run                                                                                       | Routines cannot use any default-policy integration tool today |
| 2   | Event triggers (webhook first) ([research](research/webhook-research.md))                                                   | Turns a bot from a cron job into an employee                  |
| 3   | Bot-facing tools to create routines, bots and skills                                                                        | Prerequisite for a Chief of Staff bot                         |
| 4   | Second harness (Codex) and per-bot model choice                                                                             | Every competitor sells "bring your own plan"                  |
| 5   | Remote access, one chat channel, always-on hosting                                                                          | Approvals and routines are useless away from the desk         |
| 6   | Small items: queue, templates, bot edit/delete, usage, catalog ([Google OAuth research](research/google-oauth-research.md)) | Cheap, each fixes a concrete gap                              |
| 7   | Expose bots over A2A or MCP to external agents                                                                              | Handoffs are already A2A-shaped                               |
| 8   | Bot-authored skills                                                                                                         | OpenBot has it; depends on item 3                             |

Items 1 and 2 come first because they extend the safety advantage into unattended work, where competitors are weakest.

## 1. Approvals that park an unattended run

**Shipped (parked runs).** A routine run that meets an `ask`-policy tool or an `ask_user` question no longer denies it. The tool call is refused for now, the bot is told the request went to the owner and to end its turn, and the run becomes `waiting` ("Waiting for you" in the Routines panel). The owner answers on the same cards as in a chat. When the last open request of a park is answered the run resumes in the same session, as one message holding every answer (a denial carries the owner's note), so earlier steps do not run again; an answer that comes in while the bot is still finishing its turn never parks. A park survives a restart, expires after 24 hours (the run fails with "approval expired" and the bot is told nothing was approved), and an occurrence that comes due during a park is recorded as skipped. A new session, or deleting the routine or the bot, cancels the park. A double-loop bot's routine turns are unchanged: they answer like an attended turn and never park.

ADR-0009 records what this replaced: the original plan had Allow and Block lists per tool, a 30-minute expiry and a resume through `deliver()`. There are no lists, a park lasts 24 hours, and the run resumes through the routine executor so its status and output stay the run's. What is still open from the spec ([`plans/unattended-parking/spec.md`](plans/unattended-parking/spec.md)): the unattended-approvals summary and the cost guards.

**Competitors.** Rerun: coworkers stop before consequential actions, any teammate can answer, the run resumes where it stopped, and rules can answer on the user's behalf. Rakazo: Never ask / Auto / Ask modes with Allow and Block lists that grow from approval cards; a blocked action is refused without a card.

**Done when.** A routine calls an `ask`-policy tool, the run shows as waiting, the user approves from the UI, and the run completes without re-running earlier steps. (Met for approvals and questions; see the spec's remaining tickets.)

## 2. Event triggers

**Problem.** `RunTrigger` is `schedule | manual` (`packages/contract/src/events.ts`). Rerun, Rakazo and MausBot list webhooks and app-event triggers.

Research and plan: [`research/webhook-research.md`](research/webhook-research.md).

**Plan.**

- Add a `webhook` trigger: a per-routine secret URL on the host that fires the routine with the request body passed in as data.
- Later: a poller for Gmail and GitHub changes, built on the integration clients already connected.
- Copy Rakazo's rule: writes in webhook-started runs still ask, because outside text can steer the bot. Treat the payload like page content (untrusted, wrapped). This depends on item 1 and applies even in a bot's most permissive policy.

**Decisions needed.**

- The host binds to `127.0.0.1`. A webhook needs a tunnel or relay. Pick one before building (documented tunnel recipe vs. a hosted relay). Tied to item 5.
- Dedupe and replay: a webhook fired twice must not run twice. `fire()` cannot be reused for this: `claimOccurrence` in `packages/host/src/routines/store.ts` dedupes on the schedule timestamp (`last_scheduled_for`), and a webhook has none. Needs its own key, for example a per-request id or a hash of the payload with a short window, stored with the run, and a decision on what a sender that cannot supply an id gets.

**Done when.** `curl` on the routine's URL starts a headless run with the payload visible to the bot, and a write inside it parks for approval.

## 3. Bots that create routines, bots and skills

**Problem.** Bot-facing host tools are `ask_user`, `remember`, the handoff tools, the routine tools (`create_routine`, `list_routines`, `update_routine`) and the browser tools; none of them creates bots or skills. MausBot ("automations from one sentence"), Rerun (Foreman), Turnstone and Rakazo (Chief of Staff) all let a bot set these up.

**Plan.**

- **Shipped:** `create_routine`, `list_routines` and `update_routine`, served at `/mcp/routines` on the agent listener (`mcp__routines__*`), calling the same code as the HTTP routes. There is no delete tool: a bot pauses a routine with `update_routine` `active: false`. The scripted chat test is `routines/gate-check.test.ts`; the check with the real model is the owner's (gate step 4 in `docs/plans/grok-bot-replacement-roadmap.md`).
- **Shipped:** `create_bot(name, purpose, memory?, chat_mode?)` on the bots endpoint (`mcp__bots__create_bot`), for every bot. Each call raises the normal approval card with no "always allow" and the bot exists only after the owner approves; scheduled runs are refused and the host holds at most 20 bots. The new bot starts with the browser off. See `docs/plans/chief-of-staff/spec.md`. The unfinished bot delete flow (item 6) still decides how created bots are cleaned up.
- The Chief of Staff is not a template: it is a switch on a regular bot's Profile page (`docs/plans/chief-of-staff/spec.md`) that adds a prompt section naming `list_bots`, `hand_off` and `create_bot`.

**Guards.** A bot may edit only its own routines (another bot's id answers "no such routine"). A bot may hold at most 20 routines (`create_routine` only; the panel and `/api/routines/create` are not capped). There is no per-routine approval flag: a bot-made routine runs under the bot's own tool policies, so a write left at `ask` parks the run ([ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md)). The routine tools cannot change a tool policy or an integration, and a scheduled run (a routine turn or a headless run) cannot create or change routines. `create_bot` is capped by the host-wide 20-bot limit and always asks. The Chief of Staff is a switch on a bot, not a template.

**Done when.** The user says "brief me every weekday at 8" in chat and a routine appears in the Routines panel without touching the UI.

## 4. Second harness and model choice

**Problem.** Claude Code is the only harness. `Harness` in `packages/host/src/harness/index.ts` is the seam; the handoff endpoint is already harness-neutral. Every competitor offers several providers; OpenBot also moves a bot to a backup provider on a plan limit.

**Plan.**

- Implement a Codex harness behind the existing `Harness` interface.
- Per-bot harness and model, switchable mid-conversation without losing memory or files.
- Fallback provider on rate limit or outage, with a note in the chat. Routines are the likeliest to hit limits unattended.

**Risk to settle first.** `packages/host/src/host.ts` already warns that a stored Claude login is "not valid for third-party products". Competitors market subscription sign-in anyway. Read the provider terms and decide the supported auth path before designing around it. OpenBot ships `docs/provider-terms.md` for this.

**Open question.** Session history is Claude Code's session chain (`bot.sessions`). A second harness needs a decision on what carries across: memory and files only, or a summarised transcript.

## 5. Remote access, a chat channel, always-on hosting

**Problem.** The UI is loopback-only with no auth, and the host is a manual `bun packages/host/src/host.ts`. Rerun is a PWA, OpenBot has iOS and Android apps, Rakazo adds Slack, WhatsApp, Telegram and iMessage. Approvals (item 1) and routines only help if the user can answer them away from the desk.

**Plan, in order.**

1. Authenticated remote access to the existing UI (tunnel or reverse proxy, with a login). Keep the loopback endpoints for bot tools untouched.
2. One chat channel (Slack, Telegram or Discord) that posts bot messages and approval cards, and routes replies into `deliver()`. Telegram and Discord are channels only, not catalog integrations.
3. A service wrapper (launchd, systemd) or Docker image so the host stays up. Update docs.

**Constraint.** Never expose the browser or bots endpoints without the existing token, Host and Origin checks.

## 6. Small items

Each is independent and fits in one PR. Order within the section is by user-visible pain.

### 6a. Message queue while busy (shipped; steer and pause open)

**Problem.** `/api/send` used to return 409 when `chat.busy` or a headless routine run held the bot, so the user had to wait and retype.

**Shipped.**

- On busy, `/api/send` pushes a user entry onto `chat.inbox` and emits a `queued` event. `drain()` starts the next turn once the bot is free and no headless run holds it, merging several texts into one turn. It emits `dequeued`, then the normal `user` event, when the entry reaches the bot.
- Inbox entries are tagged by `source` (`user` or `host`). Only user entries carry an id and can be cancelled: `/api/send/cancel` removes one while it has not drained and answers 404 once it has.
- The transcript shows queued messages dimmed below the working marker, with a Cancel button. A reconnecting page and `reload()` both replay or carry them.
- Mentions resolve at send time; the entry stores the resolved text for the bot and the typed text for the page.

**Open.** "Steer", which pushes into the live SDK `Inbox` in `packages/host/src/bots/thread.ts` mid-turn, and "pause". Both need SDK behaviour checked first.

### 6b. Bot templates

**Problem.** The create form (`NewBot` in `packages/web/main.tsx`) takes a name and a free-text purpose. `createBot` in `packages/host/src/bots/index.ts` stores only these; `memory.md` starts empty. A new user faces a blank box.

**Plan.**

- A static template list in the web bundle: name, purpose, memory seed, suggested integrations. Start with Inbox Manager, Coding Agent, Researcher.
- Picking one fills the form; the user can still edit. `/api/bots/new` gains an optional `memory` field written to `botMemoryPath`.
- Suggested integrations are shown as hints, not granted. Grants stay a user action.
- The Chief of Staff is a switch on a bot, not a template (item 3).

**Done when.** Choosing Inbox Manager creates a bot whose first turn already knows its job and memory seed.

### 6c. Bot edit and delete

**Problem.** No edit route or UI. Delete is built: `/api/bots/delete` (bot header, trash icon) calls `HostServer.removeBot`, which fails the bot's open handoffs, removes its routines, activity row and browser state, closes its chat and moves its directory to `bots/.trash/<id>-<timestamp>/`. It refuses with 409 while the bot is working. Restoring is manual (move the folder back). Claude session files for the bot stay in the workspace's session history.

**Plan.**

- Edit: `/api/bots/update` for name and purpose. `openThread` snapshots both into the `Thread` through `botContext`, so `configStale` and `thread.close()` are not enough: a reopened thread keeps the old persona. Save the bot, update `chat.bot`, then replace `chat.thread` with `openThread(chat.bot, true, ...)` as `/api/session/new` does. If a turn is running, defer the swap to turn end with its own flag beside `configStale`.
- UI: edit in the bot header.
- Optional: a trash view to restore or purge deleted bots, and purging `bots/.trash` automatically.

**Done when.** Deleting a bot with an open handoff and a routine leaves none of them behind, and the other bot is told the handoff failed.

### 6d. Usage and cost

**Problem.** The SDK `result` message carries `total_cost_usd` and `usage`; the host drops them. Handoff guards limit counts, not spend.

**Plan.**

- Record cost and token usage per turn, keyed by bot and, when set, by routine run or handoff id.
- Show cost on each run in the Routines panel and on handoff cards, plus a per-bot total for the current month.
- No budgets or caps here; that is a separate decision once numbers exist.

**Caveat.** On a subscription login `total_cost_usd` is an API-price estimate, not a bill. Label it "estimated".

**Done when.** A routine run and a handoff each show a cost, and the bot's monthly total equals the sum of its turns.

### 6e. Bigger catalog (shipped; Composio spike open)

**Problem.** `CatalogEntry` in `packages/host/src/integrations/catalog.ts` is data-only, so each new service is an entry, not code. The list was short; it now has 30 entries, and the open work is the Composio spike below. Google service setup for a public release: [`research/google-oauth-research.md`](research/google-oauth-research.md).

**Plan.**

- **Shipped.** 30 catalog entries in `packages/host/src/integrations/catalog.ts` (commit `5c61276`), plus 4 services (Figma, Trello, Obsidian, Paper) as custom-server recipes in [`custom-integrations.md`](custom-integrations.md). Spec: [`.scratch/integrations-catalog/spec.md`](../.scratch/integrations-catalog/spec.md). Live sign-in checks: [`.scratch/integrations-catalog/live-checklist.md`](../.scratch/integrations-catalog/live-checklist.md). Per-service research: [`research/integrations/`](research/integrations/).
- **Gmail is built in** ([ADR 0012](adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md)). It runs inside the host on the Gmail REST API with the owner's own Google client, with read, draft, organize, trash and send tools; sending always asks and cannot be switched to Auto or always allowed. No Developer Preview enrolment is needed. Calendar, Sheets, Docs and Drive still use Google's hosted preview MCP servers and are the next candidates to move to their REST APIs the same way. Open: the real-Google check of the scope, the refresh token and its 7-day expiry (ticket 03, recorded in the ADR's Evaluation).
- Spike Composio's MCP endpoint against the existing OAuth and bearer flows, as an opt-in entry with the data path disclosed (mail would pass through Composio), never the default for Gmail. If it fits, one entry covers thousands of apps; if its auth model needs a new code path, drop it. Unverified until tried.

**Done when.** Each new entry connects from the UI and one read and one write tool works from a bot, the write asking for approval.

## 7. Expose bots to external agents

ADR-0002 deferred "A2A JSON-RPC between bots" and "exposing bots as A2A servers". Handoffs have landed, so add a translation layer from the handoff store to A2A, and an MCP tool surface for external agents. One OpenMausBot contributor merged an MCP server for external orchestration, so there is demand. Needs token issuance for external callers and the same untrusted-content rule as bot-to-bot messages.

## 8. Bot-authored skills

OpenBot lets agents create, revise and install local skills with versioning. Tomte only imports skills from an integration's git repo. After item 3, add `create_skill` / `revise_skill` for skills scoped to one bot, with revisions retained.

## Deferred

- **Voice** (Rerun, Rakazo, MausBot). High cost; not tied to a current gap.
- **Multi-user teams and a template marketplace.** Conflicts with local-first, single-user.
- **Group channels where the user sits inside bot conversations** (OpenBot, Rakazo). Revisit if handoff cards prove insufficient.
- **A Turnstone-style "Brain"** that reads connected apps on a schedule and learns the user's writing voice. Needs the catalog from item 6 first.
- **Native desktop and mobile apps.** Revisit after item 5 shows whether a PWA is enough.
