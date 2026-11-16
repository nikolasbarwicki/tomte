# Spec: cost guards and run usage

Status: ready-for-agent

Gate step 5 of `docs/plans/grok-bot-replacement-roadmap.md` (section "Cost guards and usage"), and roadmap item 6d in `docs/roadmap.md` (run usage only). Depends on [spec 10, ticket 02](../unattended-parking/issues/02-parked-runs.md) for parked time, and on [spec 11, ticket 01](../telegram-channel/issues/01-channel-interface-and-link.md) for notices on the phone. Everything else stands alone. The decisions below are settled by the plan; this spec does not reopen them.

## Problem Statement

My routines run at night with nobody watching, on a VPS that is always on. If one loops, it burns my Claude plan's limits for days before I look. A bot that hangs holds its session, a Chrome and a slot in the 4 GB of memory. A routine that fails every night tells me nothing. If I stop using claudebot for weeks, every routine keeps running for nobody. And I cannot see what a run cost: the host drops the SDK's `total_cost_usd` and token counts, so I cannot tell a cheap routine from an expensive one.

## Solution

Four guards and one record, all for routines.

- **Run usage.** Every run row stores its token counts, `total_cost_usd` and the time it spent parked. The run history in the Routines panel shows them.
- **A time cap.** A run that works for 30 minutes fails. Time parked at a human wait does not count.
- **Auto-pause after failures.** A routine that fails 5 runs in a row is paused, and I am told.
- **Absence pause.** A host setting, `pauseAfterAbsenceDays` (my host uses 14; 0 is off and the default), pauses every routine when I have done nothing in the web UI or a channel for that many days. I get a warning 2 days before. The first thing I do afterwards resumes them.
- **Notices.** The host tells me through a needs-you item, so the web UI, the sidebar count, the desktop banner and, once it lands, the Telegram channel all show it. No new delivery path.

There is no dollar budget in Stage 1. On a Claude plan `total_cost_usd` is an estimate at API prices, not money spent, so the UI says "estimated". Budgets come with API keys in Stage 3.

## User Stories

1. As the owner, I want every routine run to record its input, output and cache tokens, so that I can see how much a run used.
2. As the owner, I want every run to record its `total_cost_usd`, labelled as an estimate, so that I can compare routines.
3. As the owner, I want a run's cost to be what that run spent, not the session's running total, so that a long-lived session does not make every run look expensive.
4. As the owner, I want a failed run to keep its usage, so that I can see what a looping routine cost.
5. As the owner, I want a run's parked time recorded, so that I can see how long it waited for me.
6. As the owner, I want the run history to show tokens, estimated cost and parked time for each run, so that I do not need a database tool.
7. As the owner, I want a run that works for 30 minutes to fail with a clear message, so that a hung or looping run frees its Chrome and memory.
8. As the owner, I want time parked at a human wait not to count against the cap, so that an approval that arrives at 07:00 does not fail a 03:00 run.
9. As the owner, I want a routine paused after 5 failed runs in a row, so that a loop does not run for days.
10. As the owner, I want a skipped or interrupted run to neither count as a failure nor reset the count, so that a restart does not hide a loop.
11. As the owner, I want a paused routine to show why in the Routines panel, so that I know whether I paused it or the host did.
12. As the owner, I want to resume a paused routine with the switch I already have, so that I learn nothing new.
13. As the owner, I want to be told when a routine is auto-paused, as a needs-you item on its bot, so that I notice it where I already look.
14. As the owner, I want the same notice on my phone once the Telegram channel exists, so that I learn of a loop away from my desk.
15. As the owner, I want a `pauseAfterAbsenceDays` host setting, so that a host I forget about stops spending.
16. As the owner, I want 0 to turn the absence pause off, so that I can run routines untouched.
17. As the owner, I want any request from one of my paired devices to count as presence, except the event stream, so that an open tab or the desktop app's banner stream does not hide that I am away.
18. As the owner, I want a message or button press from my linked channel account to count as presence, so that answering on my phone is enough.
19. As the owner, I want a warning 2 days before the pause, so that I can keep my routines running by opening the app.
20. As the owner, I want every routine paused when the days pass, with a notice, so that nothing runs for nobody.
21. As the owner, I want routines the absence pause stopped to resume on my first action, so that coming back needs no clean-up.
22. As the owner, I want routines I paused myself, or that failures paused, to stay paused when I return, so that "I'm back" never restarts a broken routine.
23. As the owner, I want a restart of the host not to reset the absence clock, so that a deploy does not give me 14 more days.
24. As a contributor, I want the glossary to define the new terms, so that code and docs agree.

## Implementation Decisions

### Run usage

- **Where the numbers come from.** `Thread.send` already returns the SDK's whole `result` message in `TurnResult.result`, so it does not drop `total_cost_usd` and `usage`, as the plan says. The loss is one level up: the `Executor` type in `routines/index.ts` returns `Promise<string>`, `runHeadless` returns `.text`, and `routine-turns.ts` resolves `r.text`. A turn that fails throws before any usage is read.
- **`total_cost_usd` is cumulative.** The SDK documents it (and `modelUsage`) as the running total of the `query()` call, cumulative across turns in a live session, and a resumed session's first result already carries its earlier turns. A bot's chat thread lives across turns, and a headless run opens a fresh thread with `resume` every time. So a run's cost is a difference, not a read.
- **`usage` is per turn but main loop only.** It leaves out subagents and compaction, which `modelUsage` includes. Tokens and cost must come from the same source, or they disagree. Use `total_cost_usd` and the sums of `modelUsage`'s token fields, both cumulative, with one baseline.
- **A usage mark per session.** A new table `session_usage_marks` (session id, cumulative cost, cumulative input, output, cache-read and cache-creation tokens, updated at) holds the last cumulative totals the host saw for a session. Every turn of every thread is metered, in one place, so the mark never lags: `ThreadEnv` gets a `meter` collaborator, `Thread.send` calls it with each success result and returns the turn's difference as `TurnResult.usage`. A mark that is missing means the session is new to the host. For a thread that was not resumed, the baseline is zero. For a resumed one with no mark, the turn's usage is unknown (`null`) and the mark is saved, so the next turn is exact. A total below the mark (`/clear` resets it) counts as a new baseline of zero.
- **A failed turn keeps its usage.** A result message that is an error carries cost too. `Thread.send` throws a `TurnError` (an `Error` with the turn's usage) instead of a bare `Error`, and the run's failure records it.
- **The run row.** `routine_runs` gets `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `total_cost_usd` (all nullable: `null` means unknown) and `parked_ms INTEGER NOT NULL DEFAULT 0`, by `ALTER TABLE … ADD COLUMN` in a new append-only schema step, never by editing an earlier step. Spec 10, ticket 02 rebuilds `routine_runs` for the `waiting` status; these steps are independent of it and apply in landing order.
- **Contract.** `RoutineRun` gains `usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } | null`, `costUsd: number | null` and `parkedMs: number`.
- **Web.** Each row of the run history shows tokens, "est. $x.xx" and, when above zero, the parked time. A run with no number shows nothing for it.
- **Not here.** The per-bot monthly total and handoff cards of roadmap item 6d are not Stage 1 gate work. The plan puts Stage 3's awake hours and model cost on this same table, so it needs no second meter.

### Time cap

- `createRoutines` takes `runCapMs` (default 30 minutes; tests pass a small one). A run clock starts with the run, counts active time only, and can be paused and resumed. At the cap it calls the run's `stop` with the reason, and the run ends `failed` with "run exceeded the 30 minute time limit". The thread's own error after `stop` ("Claude Code exited…") is not the message the run records: the run remembers that it expired.
- A run that finishes first clears the clock. A run stopped by `remove()` or shutdown keeps its existing handling.
- Parked time stops the clock. Entering `waiting` pauses it and stores the park's start and the active time used (`parked_at`, `active_ms`, one more append-only schema step); the resume's clock starts with the cap's remainder, so a restart does not give the run a fresh cap.
- The cap applies to every run, scheduled or manual.

### Auto-pause after failures

- After a run ends `failed`, the host reads the routine's last 5 runs whose status is `succeeded` or `failed`, newest first. When there are 5 and all failed, the routine is paused. `skipped`, `interrupted` and `waiting` runs are not in the count. Manual runs count like scheduled ones.
- Paused means `active = 0` plus a new `paused_reason` column on `routines` (`failures` or `absence`; `null` otherwise). `Routine` in the contract gains `pausedReason`. The existing `active` switch in the UI resumes it: `update` with `active: true` clears the reason and uses the baseline rule that already exists (no catch-up flood).
- Pausing disarms the schedule, the same way `active = false` does today.

### Notices

- A **notice** is a needs-you item the host raises about itself. It is stored as an external event of a new kind `notice` from the event source `claudebot` (label "Claudebot"), with a deterministic key. It never reaches the bot: unlike every other kind except `progress` it is not delivered. The user can only dismiss it.
- This reuses the events store, so the sidebar count, the Needs-you bar, the desktop banner and a channel (ADR-0010: a channel delivers every open needs-you item) show it with no new code path.
- The events route must keep refusing `notice`: it is host-only, so `ExternalEventInput` excludes it. The `external_events` kind CHECK cannot be altered, so the table is rebuilt as schema step 12 did.
- A notice closes as `resolved` when the thing it reports is undone (the routine is resumed).

### Absence pause

- **The setting.** `HostConfig.pauseAfterAbsenceDays`, a non-negative integer, from `--pause-after-absence-days` or `CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS`; default 0 (off). The host has no stored settings store: every host setting today is a startup flag read once by `parseHostConfig` (`platform/config.ts`), so this follows that pattern. A stored setting with a UI is a Stage 3 decision, when the product's default is chosen. `deploy/README.md` and `deploy/claudebot.service` stay in step.
- **Presence.** A new `presence` feature module (ADR-0003) keeps one row with the time of the owner's last action and the time of the last warning. It has two inputs.
  - The client boundary (`host-server/boundary.ts`) touches it when `devices.authenticate` accepts a request, except `GET /api/events`. The event stream cannot count: the desktop app follows it all day for the banner, and a tab keeps it open. `devices.last_seen_at` cannot be used for the same reason. Everything else a paired device sends (opening the UI, a click, a send) is a person.
  - A channel touches it when the linked owner account sends a message or presses a button. Spec 11, ticket 01 owns the channel; ticket 06 here wires it.
- **The first row.** With no row, the host writes now: turning the setting on never pauses at once.
- **The check.** An hourly timer in the composition root, and once at start, compares now with the last action. Within 2 days of `pauseAfterAbsenceDays` it raises one warning notice per bot that has an active routine (once per absence). Past it, it pauses every active routine with reason `absence` and raises one notice per affected bot. The warning needs the setting above 2: with 1 or 2 days there is no warning.
- **The return.** The first presence touch after a pause resumes every routine whose reason is `absence`, closes the warning and pause notices as `resolved`, and clears the warning mark. A routine paused for `failures`, or switched off by the owner, is not touched.
- The row is in the database, so a restart does not reset the clock.

### Delivery to a channel

Notices are needs-you items, so ADR-0010's channel delivers them. Ticket 06 proves it against the channel interface from spec 11, ticket 01, and wires channel actions to presence. Until that ticket lands, notices show in the web UI and the desktop banner only.

## Testing Decisions

- A good test drives the system from outside: a routine and its schedule in, run rows, routine state and needs-you items out. No test asserts table rows, internal calls or message wording beyond what a user sees.
- **Seam 1: `createRoutines`.** `routines/index.test.ts` uses a fake clock and an injected `Executor` over an in-memory database. Run usage, the cap, the failure count and pausing are tested here (prior art: that file).
- **Seam 2: the host HTTP seam.** `startHandoffHost` with the fake Claude CLI and a paired device cover the metering through a real thread (the fake Claude emits a configurable cumulative cost and `modelUsage`), the boundary's presence rule, the notice kind, the events route refusing `notice`, and the absence pause end to end with `--pause-after-absence-days` (prior art: `client-auth.test.ts`, `events/needs-you.test.ts`, `host-server/needs-you-answers.test.ts`).
- **Web gets no new unit tests**, as in spec 9. The Routines panel is checked by a smoke run against a dev host: a run with usage, a paused routine and its reason.
- Existing tests broken by the contract change are updated, not re-pinned to wording. Coverage gates must not drop.

## Out of Scope

- A dollar budget or any cap on spend (Stage 3, with API keys).
- A per-bot monthly total and usage on handoff cards (roadmap item 6d beyond runs).
- A token or time cap for a bot's chat turns. Guards apply to routine runs.
- A stored host settings store and a settings page. The default for `pauseAfterAbsenceDays` is a Stage 3 decision.
- Auto-pause for triggers other than schedules and manual runs (webhooks arrive with the triggers milestone).
- Retry and backoff of a failed run.

## Further Notes

- **Gate check (step 5):** a looping routine pauses itself and tells me. Ticket 03 proves it with a routine whose runs always fail; ticket 06 proves it reaches the channel.
- **Run usage is an estimate.** `total_cost_usd` on a Claude plan is the API-price equivalent, not a bill. The UI and the glossary say so.
- **Code versus plan.** The plan says `thread.send` drops `total_cost_usd` and `usage`. It returns them; the callers drop them (see above). The plan's "My host uses 14" is the owner's value; the code default is 0.
