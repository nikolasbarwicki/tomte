# Spec: unattended runs that park

Superseded in part: vault removed (`.scratch/remove-credential-vault/`, 2026-11-17). The "Vault" section, the `credential` wait kind, grants and stories 20-22 no longer apply; a login wall is "source unavailable" in a routine and a takeover in chat.

Status: ready-for-agent

Depends on nothing open. This is step 1 of the cancel gate in `docs/plans/grok-bot-replacement-roadmap.md`: Decisions 3, 4 and 5. Decisions are settled in [ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md), which supersedes parts of roadmap item 1 in `docs/roadmap.md`. The Telegram channel (`.scratch/11-telegram-channel/`) and cost guards (`.scratch/13-cost-guards/`) build on the `human_waits` table and the `waiting` status that tickets 01 and 02 put in place. The `untrusted` flag is out of scope: it belongs to the triggers milestone.

## Problem Statement

My routines run at night while I sleep. Three things can need me in the middle of a run: a tool approval, a takeover (an expired login, a CAPTCHA) and a question from the bot. Today every one of them fails the run. `headlessDelegate.approve` always denies. `browser_login` and `browser_request_takeover` refuse every unattended run, even for a vault entry I granted. `ask_user` gets a canned "no human is available" answer. A job-scout run that meets an expired login cannot ask me, and an outreach run cannot ask before it sends. Waits and asks also live in memory only, so a restart or a deploy loses them. I cannot leave a routine waiting overnight, and I cannot answer it from my phone in the morning. Until this works I cannot cancel Grok Bot.

## Solution

An unattended run that meets a human wait **parks**. It does not deny, and it does not hold a turn open.

- Every human wait (a tool approval, a takeover, an `ask_user` question, a login approval) is a row in a durable `human_waits` table. Attended waits use the same table, so there is one store. An open wait survives a restart.
- A parked run has the new `waiting` status. Its turn has ended and nothing runs. An answer resumes the same session with a message, so earlier steps do not run again.
- A park expires after 24 hours. The run then fails with "approval expired".
- An occurrence that comes due while a run is parked is skipped with "previous run is waiting for you".
- A routine uses a granted vault entry without me, because I approved its first use in a chat. A first use parks. A login step the vault cannot do (a code, a passkey) is a takeover, which parks.
- A page that asks for a login the bot has no grant for is "source unavailable": the run skips it, says so in its report and goes on. A bot wall (Cloudflare, DataDome, PerimeterX, Imperva) is detected, waited out for a short time, then handed to me as a takeover.
- An approval card gains "Always allow this for this bot" and a note on Deny. An approval covers exactly the input on the card.

## User Stories

1. As the owner, I want a routine that calls an `ask`-policy tool to park instead of failing, so that nothing fails silently at night.
2. As the owner, I want a parked run to show the `waiting` status in the Routines panel, so that I can tell a run that waits for me from one that works.
3. As the owner, I want an approval card with the exact input the tool will get, so that I know what I allow.
4. As the owner, I want an approval to cover exactly that input and nothing broader, so that a later call with other input asks again.
5. As the owner, I want the run to continue in the same session after I answer, so that earlier steps do not run again.
6. As the owner, I want a denial to reach the bot with my note, so that the bot finishes and says what it could not do.
7. As the owner, I want a routine that asks a question to park and take my answer, so that the bot never has to guess.
8. As the owner, I want chips on a parked question when the bot offered options, so that I can answer with one tap.
9. As the owner, I want a park to expire after 24 hours, whatever started the run, so that a run does not wait forever and does not expire before I wake up.
10. As the owner, I want an expired run to show `failed` with "approval expired", so that I see what happened.
11. As the owner, I want the bot told when a park expires, so that its session knows nothing was approved.
12. As the owner, I want an occurrence that comes due during a park skipped with "previous run is waiting for you", so that two runs never share a session.
13. As the owner, I want a manual test run refused while the routine is parked, so that I do not start a second run by accident.
14. As the owner, I want a parked run and its open wait to survive a host restart or deploy, so that an overnight park is safe.
15. As the owner, I want an answer that arrives after a restart to resume the run, so that a deploy does not lose the work.
16. As the owner, I want an open wait on a bot I do not have open to raise that bot's Needs-you count in the sidebar, so that I see which bot waits for me.
17. As the owner, I want the desktop banner to count open waits, so that a park does not go unnoticed with the window hidden.
18. As the owner, I want the Needs-you bar to list open waits with their buttons, so that I can answer without scrolling the chat.
19. As the owner, I want the bar's Enter key never to approve a tool, so that a stray key press cannot allow an action.
20. As the owner, I want a routine to sign in with a vault entry I already granted, so that most expired sessions fix themselves.
21. As the owner, I want a first use of an entry, or a new grant, to park for my approval, so that no routine signs in with an entry I never approved.
22. As the owner, I want a revoked grant to park again on the next run, so that revoking works for routines too.
23. As the owner, I want a routine that meets a code, passkey or CAPTCHA to request a takeover and park, so that I can finish the step on my phone.
24. As the owner, I want a parked takeover to keep its browser open until I come, so that the page I need is still there.
25. As the owner, I want the takeover's 30-minute inactivity limit to start with my first input, so that a takeover that waits for me all night does not time out before I arrive.
26. As the owner, I want a hand-back to resume the run, so that it finishes the job on its own.
27. As the owner, I want a page that asks for a login the bot cannot use to count as "source unavailable", so that one blocked site does not park or fail the whole run.
28. As the owner, I want the run's report to name the unavailable source, so that I know what is missing.
29. As the owner, I want the host to detect a Cloudflare, DataDome, PerimeterX or Imperva wall, so that the bot is told what it hit.
30. As the owner, I want the host to wait a few seconds for a wall that clears on its own, so that I am not paged for a simple check.
31. As the owner, I want a wall that does not clear to be handed to me as a takeover, so that I see it and can pass it.
32. As the owner, I want no stealth browser, CAPTCHA solver or proxy, so that no site's terms are broken.
33. As the owner, I want "Always allow this for this bot" on the approval card, so that repeated approvals become my rule for tools I trust.
34. As the owner, I want to see and remove a bot's always-allowed tools, so that I can take a rule back.
35. As the owner, I want "Off" to still deny a tool that has an always-allow rule, so that switching a tool off wins.
36. As the owner, I want a new session, a deleted routine or a deleted bot to cancel its open waits and fail its parked run, so that nothing waits for ever on a dead session.
37. As a channel author (feature 11), I want to list open waits, be told when one opens or closes, and answer one by id, so that Telegram needs no knowledge of runs.
38. As a contributor, I want one `waits` module with one table, so that approvals, questions and takeovers do not have three stores.

## Implementation Decisions

### Where things live today (what the tickets change)

- Approvals: `Thread.canUseTool` in `packages/host/src/bots/thread.ts` sends an integration tool whose policy is `ask`, then Bash and file access outside the workspace, to `delegate.approve`. The SDK call is held open until it answers. By default `HostConfig.askApproval` is false, so `approveAll` is true and only integration tools with the `ask` policy reach the delegate. This feature does not change that. `askApproval` still decides whether Bash and out-of-workspace file access ask.
- The delegate is built in `host-server/threads.ts` (`openBotThread`). With `hooks.unattended()` it answers through `headlessDelegate` (`bots/index.ts`): `askUser` returns a canned text and `approve` denies. A headless run (`routines/index.ts` `runHeadless`) uses `headlessDelegate` directly.
- Attended cards: `chat.pending` in `host-server/chats.ts` holds the resolve function of each `ask` and `approve` card. A linked ask (one about an external event) is dropped when its turn ends (`dropLinkedAsks`).
- Browser waits: `createHumanWaits` in `browser/human-waits.ts` keeps `wait` cards in a `Map`. A spec carries two closures, `resume` and `onResolve`, which cannot be stored. `Takeover` (`browser/takeover.ts`) and `createBrowserLogin` (`browser/login.ts`) use it.
- Routines: `createRoutines` in `routines/index.ts` runs a turn through `execute`. `routine-turns.ts` starts it in the bot's chat when the bot has one, otherwise headless. `fire()` skips an occurrence when `running.has(id)`, which is memory only. `RunStatus` is `running | succeeded | failed | interrupted | skipped` (`packages/contract/src/events.ts`), with a CHECK in `platform/db.ts` (`SCHEMA_V1`). `SCHEMA_V12` is the precedent for rebuilding a table to change a CHECK.
- Needs-you: the sidebar count and the bar read only external events (`events/store.ts`, `host-server/views.ts` `botsEvent`, `web/features/chat/needs-you.tsx`). A human wait is only a card in the bot's chat.
- Grants: `credentials.grant` is called from one place, the approval card of `login.ts`. No route or UI creates a grant. So "granted" means "I approved its first use".
- Bot walls: nothing detects them. `browser_request_takeover` is the only hand-off. There is no login-wall detection either; `docs/browser.md` only says a routine is "told to say so in its run result".

### The `waits` feature module (ticket 01)

- A new folder `packages/host/src/waits/` with `index.ts` (the interface) and `store.ts`. It is added to the module list in `.dependency-cruiser.cjs`. It replaces `browser/human-waits.ts` and the `chat.pending` map. The composition root passes it to chats, the browser, routines and the cleanup of a deleted bot.
- The table `human_waits` has: `id`, `bot_id`, `kind`, `run_id` (null for an attended wait), `session_id`, `payload` (JSON, by kind), `actions` (JSON `WaitAction[]`), `state` (`open | answered | expired | cancelled`), `outcome`, `note`, `created_at`, `expires_at`, `resolved_at`, `consumed_at`. There is no foreign key to `routine_runs`, because ticket 02 rebuilds that table and a `DROP TABLE` with foreign keys on would cascade.
- Kinds: `tool_approval`, `question`, `takeover`, `credential`. Their cards stay the existing events: `approve`, `ask`, `wait` and `wait_resolved`. The contract does not change for 01.
- Each kind registers one handler: how to show its card from the payload, the message the bot gets for an outcome, and what to do when it resolves (the credential grant, the takeover release). A handler works from the stored payload, so a wait can be resumed after a restart.
- The interface (the names the channel feature uses): `open` (store the row, show the card, return `{status: "waiting_for_user", id}`), `answer(id, value, note?)`, `resolve(id, outcome)` for timeout, expiry and cancel, `cancelBot`, `list` of open waits, `subscribe` to opened and closed, and `cards(botId)` to replay open cards.
- An approval or a question in an attended turn is still awaited in the same process: chats keeps a map from wait id to the resolve function. When a turn ends, the host restarts, or no continuation exists, an answer is delivered to the session as a message instead. Every wait therefore survives a restart.
- Message to the bot: `<human-wait-result id="…">…</human-wait-result>`. It replaces `<browser-wait-result>` for every kind. A note, if the owner gave one, is in it.
- Exact-input approval: when a `tool_approval` is answered `allow`, the row keeps the tool and canonical input. The next `canUseTool` call by the same bot with that tool and that exact input is allowed once (`consumed_at`). Any other input asks again. The resume message tells the bot to call the tool again with exactly that input.
- Attended waits also expire after 24 hours. A takeover keeps its own 30-minute inactivity limit.
- After a restart, an open takeover wait is resolved as `cancelled` with a message: the browser session is gone. The bot can request a takeover again. Other open waits stay open.

### Parking (ticket 02)

- The run's context: `waits.open` attaches the run id and session id of the bot's current unattended turn. A collaborator `context(botId)` gives it, which `routine-turns.ts` and `chats.ts` provide. `RoutineJob` gains `runId` and `trigger`, so the chat row no longer parses `trigger="manual"` out of the prompt.
- One `parkingDelegate` replaces `headlessDelegate` for headless and chat-hosted routine turns. `approve` opens a `tool_approval` wait and denies with a message that tells the bot to end its turn. `askUser` opens a `question` wait and returns at once with text that says the question was sent and the answer will arrive as a message.
- The turn-end rule decides everything: a turn that succeeded with an open wait parks the run (`waiting`); a turn that succeeded while every wait of the run is already answered and not yet delivered continues the run at once; a turn that failed fails the run and cancels its waits. This closes the race where I answer while the bot is still finishing its turn.
- The run resumes through the routine executor, not through a bare `chats.deliver`. ADR-0009 says "through `deliver()`". `deliver()` alone starts an ordinary chat turn that the run does not own, so the run's status, output, unattended handling and time cap would be lost. `routines.resume(runId, message)` calls the same `execute` path with the resume message as the prompt, in the same session. The message is the one `deliver()` would have sent.
- All answered waits of a run are delivered in one resume message, when the last open one closes.
- Expiry: a timer and a start-up sweep read `expires_at`. An expired wait of a run fails the run with "approval expired", tells the bot (a host message, "nothing was approved, do not retry"), and tells me in the chat. The bot's reply is a chat message, not the run's output.
- `fire()` also reads the run table: a routine with a `waiting` run records the occurrence as `skipped` with "previous run is waiting for you". A manual test run is refused with a conflict.
- Seams the cost-guard feature uses: where a run enters `waiting` (`routines/index.ts`, after the turn) and where it leaves (`routines.resume`, `routines.expire`). A resume turn runs under the same run id.
- Schema: step numbers in `platform/db.ts` are taken in landing order. Today the next free one is `SCHEMA_V14`; other features add steps too, so use the next free number when you start and never edit an earlier step.

### Takeover (ticket 04)

- `browser_request_takeover` no longer refuses an unattended run. The wait carries the run id, so the run parks.
- A requested takeover for a parked run does not arm the inactivity timer until the first input from me. Until then only the 24-hour expiry applies. Chrome stays open while the browser is held (`holdControl` already stops the idle sweep).
- The web UI already brings up the live view when a takeover wait opens (`chat.tsx`), and the live view is reachable from a phone through the bot panel sheet.

### Vault (ticket 05)

- `browser_login` no longer refuses an unattended run. A granted entry signs in as in a chat. An ungranted entry opens the existing credential approval, which parks.
- A step the vault cannot do returns `needs_another_step`, and the bot requests a takeover, which parks.
- `asking` in `login.ts` (an in-memory set) is replaced by a lookup of open `credential` waits.

### Walls (ticket 06)

- One module for page walls, `browser/page-walls.ts`, with two pure detectors over a snapshot and an optional title. It names vendors (Cloudflare, DataDome, PerimeterX, Imperva) and no site.
- A bot wall: after `browser_open` or any call that returns a snapshot (`snapshotOutcome` in `browser/tools/page.ts`), the host re-snapshots a few times with a short pause, inside the call and below the lane wait of 30 seconds. If the wall stays, the result tells the bot which vendor and says to call `browser_request_takeover`. In an unattended run that parks.
- A login wall: a snapshot with a password field, on an origin where the bot has no granted entry, gets a note: "source unavailable: report it and go on, do not try to sign in". An origin where the bot has an entry gets a note to call `browser_login`. The match is the page's exact origin against the entry's origin.
- The run prompt asks the bot to list unavailable sources in its summary.
- No stealth browser, no CAPTCHA service, no proxy.

### Always allow (ticket 07)

- A new table `tool_allowances` (bot id, tool name, created at), owned by `bots/`. `canUseTool` checks it where it asks. Off still denies, and an allowance never overrides a deny.
- The approval card has a third button, "Always allow for this bot", answered `allow_always`. It allows this call and stores the rule for the tool, not for the input.
- The card's Deny takes an optional note, which the bot receives.
- The bot panel lists a bot's allowed tools with a remove button. Deleting a bot removes its allowances.
- The `untrusted` flag will turn the rule off later. Not now.

### Contract changes

- `RunStatus` gains `waiting` (ticket 02). Every consumer handles it: `RUN_STATUS` in `web/features/routines/routine-item.tsx`, `routines/store.ts`, tests in `routines/index.test.ts`.
- `/api/answer` gains an optional `note` (ticket 07). No other contract change is planned; the cards keep their events.

## Testing Decisions

- A good test drives the host from outside, as a bot, the UI or a channel sees it: HTTP and MCP calls in, then the event stream, the run history, the messages the fake CLI received and the engine calls the fake browser engine recorded. Tests do not assert table rows or wrapper text beyond what the bot receives.
- **The seams:** the whole-host harness (`startHandoffHost` in `testing/test-host.ts`, with `restart()`), the browser tests' own host start (`browser/routines.test.ts`, `browser/takeover.test.ts`, with the fake engine `testing/fake-agent-browser.ts`) and `createRoutines` with a fake clock and fake `execute` (`routines/index.test.ts`).
- **The fake CLI cannot ask for a tool permission today.** `testing/fake-claude.ts` calls `remember` and `ask_user` only. Ticket 01 teaches it a `can_use_tool` request (an `approve.json`), so every approval test is possible.
- **Prior art:** `browser/routines.test.ts` (unattended turns, chat-hosted and headless), `browser/takeover.test.ts` (the card, the resume message, replay), `host-server/ask-event.test.ts` and `ask-user.test.ts` (asks), `handoffs/durability.test.ts` (`restart()`), `routines/index.test.ts` (the fake clock, skipped runs).
- Web: pure model tests in `web/features/chat/model.test.ts` where the needs-you rows are built. The answer path and the bar get one browser smoke each (`smoke:needs-you-ui`, `smoke:answer-ui`), because they need Chrome.
- The gate check is a human run on the VPS (ticket 08).
- Coverage gates must not drop (`AGENTS.md`).

## Out of Scope

- The `untrusted` flag and webhook, email and events-route triggers (the triggers milestone, ADR-0009).
- Telegram and any channel (feature 11). This feature gives it the interface; it sends nothing to a phone.
- Usage records, the run time cap, auto-pause and parked-time totals (feature 13). A run keeps its wait rows, so parked time can be derived.
- Allow and block lists, an approval model and any list of "sending" tools (ADR-0009).
- A stealth browser, a CAPTCHA service, proxies, and any site-specific code.
- Voice, and a mobile live view if touch input fails on a phone (ADR-0010).
- Making `askApproval` default to true.

## Further Notes

- **Code against the plan.** (1) ADR-0009 resumes "through `deliver()`". `deliver()` alone gives an ordinary chat turn that the run does not own, so a run resumes through `routines.resume`, which uses the same executor. (2) The plan calls the table `pending`; the contract names it `human_waits`. (3) By default only integration tools with the `ask` policy reach an approval, because `approveAll` is on. Parking covers those and, with `askApproval`, Bash and out-of-workspace access. (4) The plan's "a new grant parks" is the same as "a first use parks": a grant comes only from the first-use card. (5) The plan's expiry fails the run, and ADR-0009's consequences say the bot is told and writes its report. Both are done: the run fails at once, and the bot is told in a chat message after it.
- **Chrome and memory.** A parked takeover holds that bot's Chrome open for up to 24 hours. The VPS has 4 GB. Routines are staggered, and one parked takeover is one Chrome. A second routine of the same bot meets "user has control" and reports it.
- **Run output.** The text a bot writes in the turn that parks is not the run's output. The output is the last turn's text.
- **Resume messages in the transcript.** The resume message is a host message in the session. Check how `host-server/transcript.ts` shows other host tags (`<scheduled-routine>`) and treat `<human-wait-result>` the same way.
