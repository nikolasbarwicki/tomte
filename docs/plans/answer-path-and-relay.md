# Plan: external-event answers, sender and coordinator relay

Status: ready-for-agent

Integration branch: `feat/external-events`, starting at `277ebb9`.
Coordinator: `answers-1109`, OMP `anthropic/claude-opus-5-5`, thinking `medium`.
Workers: one per ticket, OMP `anthropic/claude-sonnet-5-5`, thinking `high`.

## Problem Statement

External events already reach a bot and populate Work, the transcript and Needs you, but the complete human-answer round trip is missing. Validation on 2026-11-09 reproduced three gaps:

1. Needs you **Answer… → Send** sends the free-text response but leaves the originating external item/count open.
2. Answering an `ask_user` raised for an external question resolves the internal ask but leaves the originating external item/count open.
3. Answering from Needs you while that event's `ask_user` is pending queues a new chat message, marks the external item handled, and leaves the actual ask unanswered.

There is also no current notify-style sender or answer relay to the original coordinator. Commit `f9e5fab` deliberately removed product Herdr/OMP coupling. Preserve that architectural boundary: generic events, validated reply metadata and an opt-in adapter/instruction mechanism, not a restored global Updates feed or hard-wired Herdr subsystem.

Prior evidence: `/tmp/tomte-e2e/report.txt`, `browser.test.ts`, `interactions.test.ts` and screenshots on this Mac. Treat these scratch artifacts as reproduction aids, not production code. Baseline was 758 passing tests, 94.55% line coverage / 91.79% function coverage. Read `AGENTS.md`, `GLOSSARY.md`, ADRs 0003–0007, and `docs/agents/issue-tracker.md` before work.

## Solution and User Stories

- A user's answer stays correlated with its exact bot, external event and, where applicable, pending ask and question ID. Never infer ownership from matching titles, source labels or the most recently displayed question.
- Free-text, transcript chips and Needs-you chips converge on the same answer lifecycle. Do not acknowledge on a failed request or merely because a chat message was queued. Retries and concurrent devices must not send/relay an answer twice.
- A repository-provided `tomte-notify` accepts the familiar notify argv, routes safely to the configured bot and supports `blocked` end to end.
- An optional reply target lets the originating coordinator receive the actual answer, with its question ID and session preserved. The host stays generic and obeys the existing permission/auth boundaries.
- A permanent isolated smoke proves sender → HTTP route → Needs you → answer → relay argv, plus browser regressions for all three bugs.

## Execution and Ownership

This document is the requested tracked plan, using the earlier spec's Problem Statement / Solution / Implementation Decisions / Testing Decisions structure. Existing execution-ticket convention is `.scratch/<feature>/issues/<NN>-<slug>.md`, with one ticket per file, `Status:` and appended `## Comments`. The coordinator may create those execution records under `.scratch/answer-path-and-relay/`; do not edit the old spec-9 issues or reuse its workers.

Only the coordinator writes/integrates on `feat/external-events`. Every ticket gets a fresh named worker, its own Herdr worktree and its own branch off the integration branch's current tip. Workers never share a mutable checkout. Integrate and verify one result at a time; only dispose a worker worktree after its changes are integrated and its evidence retained. Do not modify or close the old coordinator `events-1108` in `w57:p1`.

### Waves

1. Tickets **01–03**, separate workers. Start independently where possible. Before launch, agree on the minimal correlation/answer contract and file ownership. The coordinator must decide whether **02 then 03** must be sequenced because of shared pending-ask/chat changes, recording why; 01 can proceed independently where safe. Never let parallel workers edit the integration checkout.
2. **04**, after integrated wave 1.
3. **05**, after 04; choose and record the relay architecture in a short ADR.
4. **06**, after 05; run the complete round trip and the integrated gate.

The coordinator coordinates, reviews and integrates; implementation goes to ticket workers, not back to Grok Bot. Verify every worker's real process argv with Herdr process info and `ps -o pid,args` before trusting its model claim. Required argv: `omp --model anthropic/claude-sonnet-5-5 --thinking high`. Coordinator argv must show `omp --model anthropic/claude-opus-5-5 --thinking medium`.

## Implementation Tickets

### 01 — Free-text answer acks event

**Problem:** `Answer…` carries a string draft into the composer but loses event identity; a successful response does not close the source item.

**Acceptance criteria:**

- Answer… opens an editable draft correlated with the exact event/bot. Sending successfully acknowledges that event, updates its transcript row and clears Needs-you/sidebar/Work counts on every connected page.
- Opening, editing, cancelling or failing to send the draft does not acknowledge anything. An unrelated ordinary chat message never closes an item. A queued send alone is not successful consumption: retain or explicitly track the item until delivery.
- Switching bots, replacing a draft, stale events, reloads, and repeated sends cannot acknowledge the wrong event or create duplicate answers. Keep free-text and existing mentions/composer behavior intact.

**Likely files (verify, not a prescribed patch):** `packages/web/features/chat/{needs-you,composer,model,api}.tsx` or `.ts` as applicable, bot-route search/draft contract, `packages/web/host/api.ts`, host chat/event answer contracts and routes if needed.

**Tests required:** real host-seam success/failure/queued/idempotence coverage where behavior crosses the host; browser Answer…→edit→Send regression checking response, state and both badges; cancelled/failed draft and ordinary-chat negative cases.

### 02 — ask_user answer acks external question

**Problem:** transcript chip/free-text answers resolve `ask_user`, but there is no explicit link back to the external question being handled.

**Acceptance criteria:**

- An `ask_user` raised while handling a particular external question carries explicit, validated ownership of that external event. Both chip and free-text answers close only that event after successful answer delivery.
- Ordinary asks not raised for an external question are unchanged. Concurrent/queued external questions, multiple bots, a new session, retries and source resolution cannot cause cross-acknowledgment or duplicate effects.
- Transcript state and all Needs-you counts converge live and after reload. No global “latest event” heuristic.

**Likely files:** `packages/host/src/{bots/thread.ts,host-server/threads.ts,host-server/chats.ts,host-server/api/chat.ts}`, `packages/host/src/events/{index,store}.ts`, contract ask/answer shapes, `packages/web/features/chat/transcript.tsx` and chat API.

**Tests required:** host-seam external-question→ask→chip/free-text answer→event closed; unrelated ask remains independent; competing bot/event/session cases and retry; real browser regression of both answer modes.

### 03 — Needs you answer routes to pending ask

**Problem:** Needs-you chips call ordinary `/api/send`; a busy bot queues the answer and the UI immediately marks the event handled while its ask still waits.

**Acceptance criteria:**

- If this exact event has a pending ask, a Needs-you chip or free-text answer resolves that ask rather than creating a queued chat message. Only then is the external item acknowledged.
- Without a corresponding pending ask, preserve the normal answer-to-bot path with correct event correlation. Queued sends never count as handled merely because `/api/send` returned success.
- The host enforces ownership and idempotence; a stale/racing second device cannot answer another ask or duplicate a delivered answer. A failed/stale answer remains actionable or reports its already-resolved state coherently.
- Keep keyboard triage, ordinary chat queueing and the standalone ask UI working.

**Likely files:** `packages/web/features/chat/{needs-you,composer,api}.tsx` or `.ts`, `packages/web/host/api.ts`, `packages/host/src/host-server/{api/chat,chats}.ts`, external-event answer routes/contracts and pending-ask linkage from 02.

**Tests required:** held fake-CLI turn with pending correlated ask; answer via Needs you; prove ask gets the value, no queued duplicate chat answer, and no early acknowledgment. Cover no-pending-ask/queued/failure/racing-device cases and a browser regression. Coordinate shared files/contracts with 01 and 02.

### 04 — Notify sender CLI

**Problem:** coordinators have no supported repository sender, compatible report vocabulary or inspectable safe per-repository routing.

**Acceptance criteria:**

- Supply a runnable/documented repository script/bin named `tomte-notify`, compatible with `notify-grok <progress|question|blocked|completed|failed> <task_id> <session> "<message>" [question_id]`.
- Map `completed`→`done`; preserve `progress`, `question`, `failed`; add **blocked** as a supported kind end to end: route schema/validation, storage/read/replay, wrapper, transcript icon/state, Work status and Needs-you actions/counts. A blocked report wakes the bot and remains actionable, never silently coerced to progress.
- Define/document bounded, collision-resistant source/key/title/body mapping from project/task/session/question ID. Preserve full answer correlation and a stable key across network retries, without collapsing distinct messages or sources. Handle Unicode, quoting, multiline text and schema limits deliberately.
- Provide per-repo/worktree project routing and an env-file configuration model mirroring existing `notify-grok`; inspect that helper's routing behavior without printing/altering its credential files. A `--which` mode prints the selected config/path, never tokens. Respect explicitly supplied event URL/token environment and document precedence, missing-config/errors and setup.
- No secret in stdout/stderr, URLs, test artifacts or command argv; no implicit modification of the existing Grok notification setup. HTTP/auth/validation failures return useful nonzero statuses; deduped success is successful.
- Docs explain ADR-0007: sandboxed Bash cannot reach loopback, so the reporting coordinator must run outside that sandbox. Do not weaken the sandbox, bind policy or auth boundary to “fix” it.

**Likely files:** a new sender under `scripts/` or a focused CLI package, `package.json` wiring, `packages/contract/src/{api,events}.ts`, event storage/wrap/transcript and Work/Needs-you kind handling, docs/ADR-0007 references.

**Tests required:** argv mapping for all five notify kinds; blocked HTTP/stream/replay/count behavior; dedupe/collision rules; repo + Herdr-worktree routing and `--which`; env/config precedence; missing/invalid config; HTTP failure; escaped/multiline/Unicode input; secret-redaction assertions. Use fixture servers and synthetic tokens only.

### 05 — Answer relay to coordinator

**Problem:** acknowledging inside Tomte does not tell the originating agent the user's answer.

**Architecture decision required:** write a short ADR comparing (A) bot-mediated relay, giving the answer-handling bot a safe trusted relay instruction/argv from validated reply metadata, and (B) a generic opt-in locally configured relay hook that executes a fixed trusted adapter. Keep the application generic; do not restore the removed Herdr integration. Choose autonomously when the tradeoffs are clear. If the choice is genuinely ambiguous or would widen permissions, emit a text `question` with a question ID and wait in the pane, never an OS/modal dialog.

**Acceptance criteria:**

- Events may carry an optional bounded validated reply target (for example `{kind: "herdr", agent, session}`) and question ID/correlation. Events without it continue to work. Preserve it across storage/delivery/replay as needed without leaking secrets or trusting event text as instructions.
- A successfully accepted user answer through any of the three UI paths reaches the original coordinator, preserving exact answer, agent, session (default `default`) and question ID. The Herdr adapter/instruction is equivalent to `herdr agent prompt <agent> "<answer> (<question_id>)" --session default`, using the originating session when explicitly configured.
- No shell-evaluation of event-supplied commands/answers; preserve argv boundaries and handle quotes/newlines/metacharacters safely. A remote event bearer must not gain arbitrary command execution. Adapter choice and permissions belong to trusted local configuration/bot policy, not inbound free-form text.
- Relay attempts are idempotent across retry/double-click/replay; failures are visible and retryable, not silently marked successful. Distinguish queued bot input, answered ask and confirmed relay outcome; document acknowledgment/failure semantics and remaining durability limits.
- No direct product dependency on Herdr/OMP; put adapter-specific behavior at the chosen instruction/hook boundary. No `/api/notify`, Updates feed or other removed feature returns.

**Likely files:** contract event/reply metadata, event store/wrapper, correlated answer handling from 01–03, trusted bot instructions or a generic configured hook boundary, sender metadata/config from 04, new ADR and docs.

**Tests required:** fake relay executable records argv; exact target/session/question/answer round trip; events without target; malformed/unauthorized targets; malicious quoting/command injection; failed relay/retry/idempotence; multiple sources/questions/devices. Bot-mediated mode must prove the instructed fake bot invokes the mock relay, not merely assert that a prompt contains a command.

### 06 — End-to-end smoke

**Problem:** the baseline test suite passed while the real answer workflows were broken; HTTP-only assertions are insufficient for the round trip.

**Acceptance criteria:**

- Add a repeatable scripted smoke on a fresh isolated temp data root, memory/file secrets, fake Claude CLI, fake `herdr` executable and a headless browser. Never use the running localhost:5173 server's private data or real Herdr agents as test targets.
- Invoke the actual sender CLI to post a question; see it in Needs you, Work and transcript; answer through the real UI; assert the mock relay receives exactly the correct agent/session/answer/question-ID argv and the queue/counts clear appropriately.
- Reproduce and pass all three bug flows: free-text draft send, transcript ask chip/free-text answer and Needs-you answer with a genuinely held pending ask. Verify queued input cannot masquerade as delivered/relayed success.
- Include blocked, failed relay, retries/duplicate answer and injection-safe argv paths. Preserve exit status and useful failure artifacts; do not swallow failed feature checks into an overall green wrapper.
- Run browser tests on the integrated branch and retain commands, logs/screenshots, commit IDs, real process argv evidence and stated limitations in a local report. Clean up only smoke-owned processes/temp roots.

**Likely files:** a permanent smoke under `scripts/`, existing `packages/host/src/testing/{test-host,fake-claude}.ts` fixture seams where needed, host-seam regression tests, `package.json` smoke wiring and documentation.

**Tests required:** the smoke itself, all regression/adapter tests above, and **`bun run check` on integrated `feat/external-events`**. Existing coverage floors must not be lowered; resolve regressions rather than weakening checks. No full Electron launch is needed for these flows; mock all OS-facing behavior.

## Safety and Out of Scope

- Local implementation commits, worker branches/worktrees and integration onto `feat/external-events` are in scope. No pushes, PRs, tags, releases, merges into `master`/`main`, deployments, installer distribution or notarized releases without Nikolas's explicit approval in chat.
- Never read, export, modify or change ACLs of keychain items. Tests use `memorySecrets` or a temp file backend only. Never print secrets or dump credential environments/config contents.
- Never automate OS dialogs. No sudo, TCC changes, quarantine removal or security bypass. Questions are text with question IDs, not OMP `ask`/modal dialogs.
- Do not delete app data, caches, other agents' branches/worktrees or unrelated files. Dispose only your own worker worktrees, after integration. Leave old coordinators alone.
- Do not kill/restart the existing dev server, launch the installed app, or test against a default user data root. Use isolated roots, free ports and mocks; no real paid model turns in smokes.
- Do not bring in release/keychain/prototype branch changes or change token scope/auth/Origin boundaries beyond the approved design without an explicit decision.

## Reporting Contract

Run reports **from a tomte worktree**:

```sh
GROK_NOTIFY_PROJECT=tomte notify-grok --which
GROK_NOTIFY_PROJECT=tomte notify-grok <progress|question|blocked|completed|failed> <task_id> <session> "<message>" [question_id]
```

Before every send, confirm `--which` resolves exactly to `~/.config/grok-bot/notify-tomte.env`. It currently resolves to `notify.env` (Conductor) because the project env is not yet set up. **Do not send to that fallback.** Do not create/read/dump the env file yourself; Nikolas will run `notify-grok-setup tomte`. Keep doing unblocked work, retain pending reports locally, and retry the route check at later milestones once the env exists. Do not use an alternative service or silently fall back to Conductor.

Use ticket task IDs such as `01-free-text-acks-event`, `02-ask-user-acks-event`, `03-needs-you-routes-ask`, `04-notify-sender`, `05-answer-relay`, `06-e2e-smoke`; session is the actual coordinator OMP session identifier, recorded at startup (agent name `answers-1109` may be included for orientation). Batch progress into real milestones. Report questions, blockers, failures and completions promptly when routing is correct. For a real question, write it with a stable question ID, recommended answer and decision needed in the pane, send if routing permits, then stop and wait there for the reply. If routing is unavailable, do not misroute: leave the visible question in the pane and wait.

Final coordinator report: per-ticket workers/panes/branches and verified argv, integrated commits, ADR decision, `bun run check` result and counts/coverage, full smoke command/evidence, unresolved risks and all unsent reports. State explicitly that nothing was pushed, released, deployed or merged into master.
