# 0009: Unattended runs park on durable human waits

Status: accepted. Supersedes parts of roadmap item 1 in `docs/roadmap.md` (see Consequences). Relies on [ADR-0002](0002-bot-handoffs-are-async-a2a-tasks-on-a-host-endpoint.md): tools return at once and events arrive as messages.

Amended 2026-11-17: the credential vault was removed (`.scratch/remove-credential-vault/`). The credential approval wait kind, `browser_login` and "Vault use unattended" below no longer exist. A sign-in page in an unattended run is always "source unavailable"; in chat the bot requests a takeover.

## Context

A routine runs while nobody watches. Three things can need the owner in the middle of a run: a tool approval (`ask` is the default policy), a takeover (an expired login, a CAPTCHA) and an `ask_user` question.

Today none of them can work in a routine.

- `headlessDelegate.approve` in `packages/host/src/bots/index.ts` always denies, so a routine that must send one email fails.
- `browser_login` (`browser/tools/credentials.ts`) and takeover (`browser/tools/takeover.ts`) refuse every unattended run, even for a vault entry the owner granted.
- Waits and asks live in memory only (`chat.pending` in `host-server/chats.ts`, `human-waits.ts`). A restart or a deploy loses them, and a run that waits all night is a run whose state a restart can erase.

Approvals are also awaited in-process: `canUseTool` in `bots/thread.ts` holds the SDK call open until `delegate.approve` answers. That is fine for a person at the screen. For a run that may wait for hours it holds a turn, a Chrome and a process for nothing.

The owner's phone is the usual place to answer ([ADR-0010](0010-channels-deliver-needs-you-items.md)), so the answer can arrive hours after the question, from a place that is not the web UI.

## Decision

An unattended run that meets a human wait parks. It does not deny and it does not hold the turn open.

- **One durable table.** Every human wait is a row in a `human_waits` table: kind (tool approval, takeover, `ask_user` question or credential approval), bot, run id, session id, payload and expiry. The web UI, every channel and the expiry check read it. The in-memory waits and asks in `chat.pending` and `human-waits.ts` move onto it, so an open wait survives a restart. This covers attended waits too: one store, not two.
- **Parking ends the turn.** The run gets a new `waiting` status (`RunStatus` in `packages/contract/src/events.ts`, and the status CHECK on `routine_runs` in `platform/db.ts`, which SQLite cannot alter, so the table is rebuilt as `db.ts` already did once). The tool returns at once with a result that says the request is waiting for the owner, and the bot is told to finish its turn.
- **Resume is a message.** The answer is sent as a message into the same session through the routine executor (`routines.resume(runId, message)`), as ADR-0002 has events arrive as messages, so the run keeps its status, output and unattended handling. Plain `deliver()` would start an ordinary chat turn the run does not own. The session keeps its context, so earlier steps do not run again. A denial resumes the session the same way, with the owner's note, and the bot finishes.
- **One expiry: 24 hours.** Every park expires after 24 hours, whatever started the run. The run then fails with "approval expired" and the owner is told. This replaces the 30 minutes in roadmap item 1, which would end every night-time park before the owner wakes up.
- **Occurrences are skipped while parked.** `fire()` already skips when `running.has(id)`. A parked run is not running in memory, so the check also reads the run's status: an occurrence that comes due while a run is `waiting` is recorded as skipped with "previous run is waiting for you". Two runs never share a session.
- **An approval covers exactly the input shown on the card.** Nothing broader is inferred from it. "Always allow this for this bot" is the owner's explicit choice, per tool, made on the card.
- **No send-tool classification.** The code keeps no list of which tools send, buy or delete. A send to someone else needs no rule of its own: it is the default `ask` policy. Which tools ask is the owner's per-tool policy, and the code does not guess.
- **Vault use unattended.** A routine uses a granted vault entry without the owner only when the owner approved that entry's first use interactively (`login.ts` asks on first use). A first use, or a new grant, parks. A takeover parks and pings the owner, and the run continues in the same session when the owner hands the browser back.
- **No park for a source that needs a login the bot lacks.** A page that asks for a login on a site where the bot has no granted vault entry is "source unavailable": the run skips it, says so in its report and goes on. It does not park. The code names no site; bot-wall detection and hand-off are a separate decision.
- **The `untrusted` flag comes with the triggers milestone, not now.** It is stored on runs and turns started by a webhook, an email or `POST /api/bots/<id>/events`. Under it every `auto` integration tool asks, and "always allow" does not apply. Whether the host-served tools (`mcp__host__*`, `mcp__browser__*`, `mcp__bots__*`, `mcp__routines__*`), which `canUseTool` allows before any policy check today, also ask is decided with the triggers milestone (`docs/research/webhook-research.md` proposes they do). Today nothing marks such a turn and `auto` tools run freely in it. Browsing does not set the flag: every routine that browses reads untrusted pages, so tool policies are the defence there.

## Alternatives considered

- **Allow and block lists built from earlier approval cards (Rakazo).** Fewer interruptions over time. Rejected for now: a broad rule can approve too much. "Always allow this for this bot" on the card covers the same need for the tools the owner picks. Roadmap item 1's block lists are dropped with it.
- **A model that judges what was already authorized (Grok Bot's "smarter approvals").** The fewest interruptions. Rejected: the model decides what is safe, and an injected page can argue with it.
- **Full access by default (MausBot, OpenBot).** No interruptions. Rejected: one injected page then acts with every permission.
- **Deny everything (today).** Safe, but any routine that needs one approval fails.
- **Hold the tool call open until the owner answers.** Rejected for the reasons in ADR-0002: a held turn holds a process and a Chrome, and a restart loses it.
- **Expire after 30 minutes (roadmap item 1, as takeover does).** Rejected: the owner is usually asleep when a 03:00 routine asks.
- **Keep waits in memory and rebuild them on restart.** Rejected: the payload (the exact input) cannot be rebuilt from the session, and a channel needs to read open waits without the run.

## Consequences

- Nothing fails silently: a routine that cannot proceed shows as `waiting`, and the owner is told.
- **Supersedes in `docs/roadmap.md` item 1:** "Add Allow and Block lists per tool, fed from approval cards" (replaced by "always allow" on the card), "Auto-expire a wait after a fixed time, as takeover does (30 minutes)" (replaced by 24 hours), "On approval, resume the run through `deliver()`" (replaced by resume through the routine executor), and "Whether to add an approval model ... Start with lists" (decided: no model, no lists). The `waiting` status and the use of the existing `wait` and `wait_resolved` events stand. "Resume in the same turn or as a new message" is decided: a new message.
- A parked run does not keep a machine awake in Stage 3; only a running turn does. The host must be reachable for the answer, which is what makes a channel's webhook wake a sleeping machine.
- The parked time is recorded on the run (run usage), so a time cap on a run does not count it.
- A `waiting` run needs the `routine_runs` rebuild and a contract change, and every consumer of `RunStatus` handles the new value.
- A deny or an expiry ends a run with the work before it done and the rest not. The bot is told and writes its report.
- Until the `untrusted` flag exists, a webhook- or email-started run is not stricter than any other. The triggers milestone must not ship without it.
