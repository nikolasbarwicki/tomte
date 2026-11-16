# 09: Double-loop bots' routine runs run headless and park

**What to build:** A routine run of a double-loop bot runs headless, exactly as a standard bot's routine runs when its chat is not open, so it parks like any other run: the parking delegate, the `waiting` status, resume through `routines.resume`, survival of a restart and the 24-hour expiry. Today (after ticket 02) a double-loop bot's routine turn goes to the front session, its waits carry no run id, and the run never parks. Follow-up to ticket 02, decided by the owner (question `dl-parking`, option c).

**Blocked by:** 02

**Status:** ready-for-agent

- [x] `routine-turns.ts` (and whatever in `host-server/chats.ts` hands routine jobs to the front) starts every routine run of a `double_loop` bot headless, whether or not its chat is open, in its own session; the front session never receives the routine prompt or a resume message
- [x] Such a run parks on an approval and on an `ask_user` question exactly as a standard bot's headless run: `waiting` in the Routines panel, Allow/Deny/answer resume it in the same headless session, a restart keeps it `waiting` and an answer afterwards resumes it, an expired park fails it with "approval expired"
- [x] The run reports through its run output and the Routines panel, not through the front chat. The front's context and work state are untouched by the run
- [x] The 02 note in `AGENTS.md` (Double-loop section) is replaced by the new rule
- [x] A short decision note in ADR-0011 (double-loop chat mode), or a new ADR if that fits better, says: double-loop routines run headless, do not use the front session's context, and report through the run output and the Routines panel, not the front chat. `docs/browser.md`, routines docs and `GLOSSARY.md` say so where they describe routine runs or double-loop mode
- [x] Host-seam tests with the fake CLI (prior art `host-server/parked-runs.test.ts`): a double-loop bot's routine parks on `approve.json` and resumes on Allow to `succeeded`; one parks on `ask.json` and the answer resumes it; the front received neither the routine prompt nor the resume message. The existing double-loop routine test is rewritten to the new rule. `bun run check` passes

## Comments

- Done. A double-loop bot's run has a session of its own: `routines/index.ts` writes a fresh session id into `routine_runs.session_id` at `run()` and every turn (first and resumes) passes it as `RoutineJob.ownSession`; `runHeadless` opens the thread with it (`openThread` takes a `sessionId`). No `SCHEMA_Vn` used: the column already existed.
- Deviation from "the bot's session": the brief says "in its own session", so a run does not write the front's session. A consequence is that such a run does not block the front or the composer (`RoutineTurns.headless` stays for runs in the bot's current session only). `headlessRun`/`Chats.runOf` see own-session runs, so the run's waits (and the browser's, once tickets 04 and 05 land) carry its id. The front's own waits are opened with `runId: null` (`WaitSpec.runId` accepts null) so a question the front asks while a run is parked never joins the run. The stored `human_waits.session_id` of a wait of such a run is still the bot's current (front) session; nothing reads it.
- An expired park of a double-loop run fails the run with "approval expired" and tells nobody (no chat notice, no message to the front): the run's session is not continued. The Routines panel shows the failure.
- Removed as dead after the cutover: `Chat.frontWaiters`, `Chat.held`, `settleWaiters`, `messageFront` and the headless guards on the front paths in `chats.ts`. The front prompt no longer mentions `<scheduled-routine>` messages.
- Tests: `host-server/double-loop-routines.test.ts` (approve.json and ask.json park and resume, restart, expiry, chat open and closed; the front keeps answering and its question is not the run's); the existing test in `double-loop-chat.test.ts` was rewritten to the new rule.
- Smoke: `bun run smoke:loop-ui` passed (the change touches the front paths in `chats.ts`; the smoke drives no routine).
