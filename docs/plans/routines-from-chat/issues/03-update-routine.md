# 03: `update_routine` (edit and pause)

**What to build:** A bot edits, pauses or resumes one of its own routines from chat. There is no delete tool: pausing is `active: false`. See the spec sections "Tool schemas" and "Guards".

`routines/tools/update-routine.ts` exports `registerUpdateRoutine(mcp, ctx)`. The input is `routine_id` plus any subset of `name`, `instruction`, `schedule` (`ScheduleArg`), `catch_up` and `active`, with at least one. The handler:

1. Refuses while `ctx.unattended(botId)` is true, with the same message as `create_routine`.
2. Loads the routine with `routines.get(routine_id)`. A missing routine, and a routine whose `botId` is not the caller's, both answer "no such routine".
3. Refuses an update with no fields: "nothing to change".
4. Maps the arguments with the `schedule-arg.ts` helper from ticket 02, runs `RoutinePatch.safeParse` (`routines/index.ts`) and returns the first issue on failure.
5. Calls `routines.update(id, patch)` and returns `{ now, routine }`. `routines.update` re-arms the job and moves the claim baseline (`lastScheduledFor`) as the panel's edit does, so a paused or rescheduled routine does not count the time in between as missed. That logic stays where it is.

The tool description says that pausing does not stop a run already in progress, and that a run that is `waiting` for the owner (after [ADR-0009](../../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md)) is not cancelled either. An edit applies from the next occurrence.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `update_routine` with `active: false` pauses the routine: `/api/routines/list` shows `active: false` and no next run, and the result has an empty `next_runs`. `active: true` resumes it and `next_runs` returns
- [ ] Changing only the schedule keeps the name and instruction. Changing only the name keeps the schedule. The result shows the new `next_runs`
- [ ] A schedule change is checked by the same rules as `create_routine` (bad cron, unknown time zone, once in the past, interval under 5 minutes) and an invalid one changes nothing
- [ ] With the bot open, each update reaches the stream as a `routines` event
- [ ] A bot cannot update another bot's routine, and an unknown id answers the same "no such routine", so ids are not revealed. The other bot's routine is unchanged
- [ ] A call with only `routine_id` answers "nothing to change"
- [ ] While the bot runs a routine turn or a headless run, `update_routine` is refused with the "scheduled runs cannot create or change routines" message. A routine cannot pause itself this way
- [ ] No tool in the endpoint deletes or runs a routine: the server lists exactly `list_routines`, `create_routine` and `update_routine`
- [ ] Host HTTP-seam tests cover all of the above through `actAs(botId, "routines")` (prior art: `handoffs/guardrails.test.ts`, `routines/index.test.ts` for the baseline rules). `bun run check` passes
