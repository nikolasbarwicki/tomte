# 02: `create_routine`

**What to build:** A bot creates a routine for itself from chat, and the routine shows up in the Routines panel. See the spec sections "Tool schemas" and "Guards".

`routines/tools/create-routine.ts` exports `registerCreateRoutine(mcp, ctx)`. The input is `name` (≤ 80), `instruction` (≤ 8 KiB), `schedule` (`ScheduleArg`: `cron` with `expr` and `tz`, or `once` with an ISO `at` that has an offset), and optional `catch_up` and `active`. The handler:

1. Refuses while `ctx.unattended(botId)` is true: "scheduled runs cannot create or change routines; ask the user in chat".
2. Refuses when the bot already has 20 routines (`MAX_ROUTINES_PER_BOT`), telling the bot to ask the owner to delete one in the Routines panel.
3. Turns `at` into epoch milliseconds and runs the route schema, `RoutineInput.safeParse` (`routines/index.ts`). A failure returns `errorResult("<path>: <message>")` for the first issue.
4. Calls `routines.create(ctx.botId, input)` and returns `{ now, routine }` in the `RoutineOut` shape. `routines.create` arms the job and calls `onChange`, so the open bot's panel updates through the existing `routines` event.

The shared `ScheduleArg` and the argument-to-route-input mapping (`catch_up` → `catchUp`, `at` → epoch) go in `routines/tools/schedule-arg.ts`, since ticket 03 needs them too.

Contradiction to note in the PR: `RoutineInput.schedule` is `z.unknown()`, so the route schema alone gives a model no JSON schema. The tool declares `ScheduleArg` for the model and still sends the values through the route schema, so `parseSchedule` stays the one judge.

**Blocked by:** 01

**Status:** done

- [x] `create_routine` with a cron schedule creates an active routine for the calling bot with `catch_up` true unless given. The result has the routine, `next_runs` and `now`. `/api/routines/list` for that bot returns it
- [x] With that bot open, the event stream carries a `routines` event holding the new routine, without any UI call
- [x] A `once` schedule with an ISO `at` in the future creates a routine that fires once. An `at` without an offset is refused by the schema. An `at` in the past is refused with "time is in the past"
- [x] A bad cron, an unknown time zone, a schedule that never fires and a cron that runs more often than every 5 minutes each return an error result that carries the route's message (for example "minimum interval is 5 minutes") and create nothing
- [x] A name over 80 characters, an instruction over 8 KiB and an empty name or instruction return error results
- [x] The 21st routine of one bot is refused with a message that names the cap. Another bot is not affected. The panel and `/api/routines/create` are not capped by it
- [x] While the bot runs a routine turn or a headless run, `create_routine` is refused with the "scheduled runs cannot create or change routines" message and nothing is created. `list_routines` still answers
- [x] The tool has no argument for a bot id, a tool policy, a grant or an integration. A routine it creates has the same tool policies as one created in the panel
- [x] Host HTTP-seam tests cover all of the above through `actAs(botId, "routines")` (prior art: `handoffs/guardrails.test.ts`, `routines/index.test.ts`; the unattended case holds a routine turn open the way `hold()` does). `bun run check` passes
