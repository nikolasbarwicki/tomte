# 09: Double-loop bots' routine runs run headless and park

**What to build:** A routine run of a double-loop bot runs headless, exactly as a standard bot's routine runs when its chat is not open, so it parks like any other run: the parking delegate, the `waiting` status, resume through `routines.resume`, survival of a restart and the 24-hour expiry. Today (after ticket 02) a double-loop bot's routine turn goes to the front session, its waits carry no run id, and the run never parks. Follow-up to ticket 02, decided by the owner (question `dl-parking`, option c).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `routine-turns.ts` (and whatever in `host-server/chats.ts` hands routine jobs to the front) starts every routine run of a `double_loop` bot headless, whether or not its chat is open, in its own session; the front session never receives the routine prompt or a resume message
- [ ] Such a run parks on an approval and on an `ask_user` question exactly as a standard bot's headless run: `waiting` in the Routines panel, Allow/Deny/answer resume it in the same headless session, a restart keeps it `waiting` and an answer afterwards resumes it, an expired park fails it with "approval expired"
- [ ] The run reports through its run output and the Routines panel, not through the front chat. The front's context and work state are untouched by the run
- [ ] The 02 note in `AGENTS.md` (Double-loop section) is replaced by the new rule
- [ ] A short decision note in ADR-0011 (double-loop chat mode), or a new ADR if that fits better, says: double-loop routines run headless, do not use the front session's context, and report through the run output and the Routines panel, not the front chat. `docs/browser.md`, routines docs and `GLOSSARY.md` say so where they describe routine runs or double-loop mode
- [ ] Host-seam tests with the fake CLI (prior art `host-server/parked-runs.test.ts`): a double-loop bot's routine parks on `approve.json` and resumes on Allow to `succeeded`; one parks on `ask.json` and the answer resumes it; the front received neither the routine prompt nor the resume message. The existing double-loop routine test is rewritten to the new rule. `bun run check` passes
