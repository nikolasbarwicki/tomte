# 06: Routine results on my phone, per routine

**What to build:** A routine can opt in to sending a short result to my phone when a run succeeds. The Routines form gets a checkbox, default off. The message carries the routine's name, the run's output cut short and a link to the run in the web UI. See the spec section "Notices and results".

`catchUp` is the precedent for a routine flag that travels end to end: the `routines` column (`platform/db.ts`, `SCHEMA_V1`), `RoutineRecord` and its SQL in `routines/store.ts`, `RoutineInput` and `RoutinePatch` in `routines/index.ts`, `Routine` in `packages/contract/src/events.ts`, and the form (`features/routines/routine-form.tsx`, `use-routine-form.ts`). Add `notifyResult` the same way. The result is sent from the `onRunEnded` seam and `Channels.notify` of ticket 05, as a new notice kind `routine_result`.

The routine prompt already asks each run to end with a summary of at most 5 lines (`prompt()` in `routines/index.ts`), so the run's `output` is the result.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A schema step adds `notify_result INTEGER NOT NULL DEFAULT 0` to `routines` with `ALTER TABLE ... ADD COLUMN` (no CHECK is changed, so no table rebuild). Existing routines stay off
- [ ] `Routine` in the contract gains `notifyResult: boolean`. `RoutineInput` and `RoutinePatch` accept it and the HTTP routes (`host-server/api/routines.ts`) pass it through, for create and update. Absent on create means off. A patch that omits it keeps it
- [ ] The routine form has a checkbox "Send the result to my phone", with the description "Needs a linked channel (Channels page)", default off. It does not import the channels feature (ADR-0004); it is always enabled
- [ ] A run that ends `succeeded` on a routine with `notifyResult` sends one `routine_result` notice: "<routine name>: <output>", the output cut to about 800 characters with "…", and a URL button to `<public URL>/bots/<botId>?panel=routines` (no button on a loopback public URL). An empty output sends "<routine name> finished" with no summary
- [ ] A routine without the flag sends nothing on success. Its failures, interruptions and expired parks are still sent by ticket 05, flag or not. A failed run on a flagged routine sends the failure notice only, not also a result
- [ ] A scheduled run, a manual test run and a parked run that resumed and then succeeded each send exactly one result when the routine opted in
- [ ] Turning the flag off or deleting the routine before a run ends sends nothing for that run. The flag is read when the run ends, not when it started
- [ ] Host seam tests with the fake Telegram server and the fake Claude CLI cover each bullet; the routine form's checkbox is covered by the browser smoke from ticket 02 (add a step). `bun run check` passes
