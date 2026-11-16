# 03: A routine that fails 5 runs in a row pauses itself and tells me

**What to build:** After a run ends `failed`, the host checks the routine's last runs. Five failures in a row pause the routine and raise a notice, a needs-you item, on its bot. This is the gate's check: a looping routine pauses itself and tells me. It also introduces the notice, which tickets 05 and 06 reuse. See the spec sections "Auto-pause after failures" and "Notices".

Notices reuse the external events store (`events/`, `external_events`), so the sidebar count, the Needs-you bar and the desktop banner show them with no new path, and ADR-0010's channel delivers any open needs-you item. A notice is the new event kind `notice` from the source `claudebot`. `events.post` delivers every kind except `progress` to the bot, so the host's notice path stores the event without delivering. `ExternalEventInput` (`packages/contract/src/api.ts`) must exclude `notice`: only the host raises it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A new append-only schema step rebuilds `external_events` with `notice` in the kind CHECK (the precedent is schema step 12: keep rowids, make the indexes again) and adds `routines.paused_reason TEXT CHECK (paused_reason IN ('failures','absence'))`
- [ ] `ExternalEventKind` in the contract gains `notice`. The events route refuses a `notice` post with 400, and the route's `ExternalEventInput` stays unable to carry it. Every consumer of the kind (`events/store.ts` status derivation, `web/features/chat/model.ts`) handles it: a notice is never delivered to the bot, has no transcript row, and offers Dismiss only
- [ ] The events module gets `notice(botId, { key, title, body })` and a way to close notices as `resolved` by key. A notice key repeats safely: posting it twice makes one item
- [ ] `routines/store.ts` reads a routine's last 5 runs with status `succeeded` or `failed`, newest first. `skipped`, `interrupted` and `waiting` runs are not in the count, and manual runs count. When 5 rows come back and all are `failed`, `run()` pauses the routine right after `finishRun`: `active = 0`, `paused_reason = 'failures'`, the schedule disarmed, `onChange` called
- [ ] The host raises the notice "<routine name> paused after 5 failed runs", with the last run's error as body, on the routine's bot. The routine and the notice do not need the bot to be open
- [ ] `Routine` in the contract gains `pausedReason`. The Routines panel shows "Paused after 5 failed runs" on a paused routine. The existing switch resumes it: `update` with `active: true` clears the reason, uses the existing baseline rule (no catch-up flood), and closes the routine's open pause notice as `resolved`. Editing the instruction or schedule does not resume it
- [ ] A succeeded run between failures resets the count. A routine at 4 failures that has one interrupted run is still at 4
- [ ] The gate check passes end to end at the host seam: a routine whose runs always fail (the fake CLI errors) is scheduled; after its 5th failed occurrence it is inactive with reason `failures`, a needs-you item for it is open on its bot and counted in the bots slice, no 6th run starts, and flipping the switch on resumes it and closes the item
- [ ] GLOSSARY gains **Paused routine** (a routine the host stopped, with its reason) and **Notice** (a needs-you item the host raises about itself; the owner can dismiss it and the bot never sees it)
- [ ] Tests at the `createRoutines` seam (count rules, pause, resume clears the reason, no pause at 4) and at the host HTTP seam (the gate check, the route refusing `notice`, the item in the bots slice and closing as `resolved`). `bun run check` passes
