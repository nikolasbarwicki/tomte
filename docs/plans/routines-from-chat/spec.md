# Spec: routines from chat

Status: ready-for-agent

Depends on nothing open. Gate step 4 of `docs/plans/grok-bot-replacement-roadmap.md` ("The cancel gate"). This is roadmap item 3 (`docs/roadmap.md`), routines only: no `create_bot`, no skills. Related: [ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md) (what a bot-made routine does when it needs approval), [ADR-0001](../../docs/adr/0001-browser-engine-behind-host-mcp-endpoint.md) and [ADR-0002](../../docs/adr/0002-bot-handoffs-are-async-a2a-tasks-on-a-host-endpoint.md) (tools on a host endpoint).

## Problem Statement

Grok Bot lets me say "brief me every weekday at 8" and the routine exists. In claudebot I have to leave the chat, open the Routines panel, pick a preset, write the name and the instruction, and save. Routine CRUD exists only under `/api/routines/*`, which a bot cannot call. None of the bot-facing tools (`ask_user`, `remember`, `rewrite_memory`, the handoff tools, the browser tools) manages routines. I cannot cancel Grok Bot until this works from chat.

## Solution

Three host tools, `create_routine`, `list_routines` and `update_routine`, served to every bot session. They call the same code as the HTTP routes: `createRoutines().create`, `.update` and `.list`, with the schedule checked by `parseSchedule`. A bot sees and changes only its own routines. Pausing is `update_routine` with `active: false`. There is no delete tool.

- The tools live on a new host-owned MCP endpoint on the agent listener, next to the bots endpoint. The server is named `routines`, so the bot sees `mcp__routines__create_routine` and so on.
- The caller is the bot the session token belongs to. It is never an argument.
- A routine made this way is an ordinary routine. It shows up in the Routines panel through the existing `routines` event, runs under the bot's own tool policies and parks like any other routine ([ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md)).
- A scheduled run may read its routines but may not create or change them.

## User Stories

1. As the owner, I want to say "brief me every weekday at 8" in a bot's chat and get a routine, so that I never open the Routines panel for a simple schedule.
2. As the owner, I want the routine to appear in the Routines panel at once, so that I can see and edit what the bot made.
3. As the owner, I want the bot to tell me the schedule, the time zone and the next run, so that I can catch a wrong time before it runs.
4. As the owner, I want the bot to use my time zone, not the server's, so that "8" on a VPS in UTC does not mean 08:00 UTC.
5. As the owner, I want the bot to ask once for my time zone and remember it, so that I am not asked again.
6. As the owner, I want to say "pause the weekday brief" and have the routine pause, so that I can stop it without the UI.
7. As the owner, I want to say "move the brief to 7:30" and have only the schedule change, so that the instruction and history stay.
8. As the owner, I want a bot to list its routines when I ask what it runs, so that I learn without opening the panel.
9. As the owner, I want a bot to be unable to see or change another bot's routines, so that one confused bot cannot rewrite another bot's job.
10. As the owner, I want a bot to have a bounded number of routines, so that a looping bot cannot fill the schedule.
11. As the owner, I want a bot-made routine to follow the same approval rules as one I made, so that a write still asks and parks, and no routine tool can switch a policy to `auto`.
12. As the owner, I want a scheduled run to be unable to create or edit routines, so that a routine, or a page it reads, cannot plant new recurring work.
13. As the owner, I want the schedule rules of the panel to apply to a bot's routines: valid cron and time zone, one-time in the future, at least 5 minutes between runs, so that a bot cannot set up a run storm.
14. As the owner, I want a clear error when the bot's schedule is wrong, so that the bot can fix it and try again in the same turn.
15. As a contributor, I want the tools to reuse the route code, so that the panel and the bot can never disagree about what a valid routine is.
16. As a contributor, I want the glossary and roadmap to say what the tools are and how the "approval-required" guard is met, so that nobody adds a second approval mechanism.

## Implementation Decisions

### Where the tools live

- A new host-owned Streamable HTTP MCP endpoint, `POST /mcp/routines` on the **agent listener**, served by `serveMcpRequest` (`host-mcp/index.ts`). The checks are the ones of ADR-0001: Host header, no Origin, a bearer token issued to a live bot session. The endpoint follows `handoffs/endpoint.ts`: `lease(botId)` returns a `HostServerLease` with the server, a per-session token and the instructions; a fresh `McpServer` answers each request.
- The feature is `routines/`. New files: `routines/endpoint.ts` (`createRoutinesEndpoint`, `ROUTINES_ENDPOINT_PATH`, `ROUTINES_SERVER_NAME`, `ROUTINES_INSTRUCTIONS`) and `routines/tools/<tool>.ts`, one file per tool, each exporting `registerX(mcp, ctx)`, the way `handoffs/tools/` does. `routines/index.ts` re-exports the endpoint. `createRoutines` keeps its signature, so `routines/index.test.ts` does not change.
- **Why not `mcp__host__`.** The plan calls these "host tools". ADR-0001 says in-process tools stay for `ask_user`, `remember` and `rewrite_memory` only, because every new harness would need its own copy. `mcp__host__` is also the prefix that [ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md) exempts from the future `untrusted` rule. Routine tools are persistent instructions, so they should not be exempt. A host-owned endpoint is the same shape as the handoff tools.
- The composition root (`host-server/index.ts`) builds the endpoint right after `createRoutines`, adds its lease to `hostServers` (`combineLeases`), and adds the route to `agentRoutes` in `host-server/http.ts`. `HostServer` gains `routines: RoutinesEndpoint`, as it has `bots`. `hostServers` runs only when a thread opens, so the lease may refer to `routines`, which is built after it, the way `chats` is today.
- `canUseTool` in `bots/thread.ts` allows `mcp__host__`, `mcp__browser__` and `mcp__bots__` before it looks at integrations. It also allows `mcp__routines__`.
- Endpoint context (`RoutinesToolContext`): `botId` (from the token), the `Routines` interface, `unattended(botId)` (the composition root passes `chats.unattended`, which the browser endpoint already takes) and `now()`.

### Tool schemas

Argument names are snake_case, as in the handoff tools (`handoff_id`). The input shape is Zod, passed to `registerTool` as `inputSchema`. The routes' `RoutineInput` types `schedule` as `z.unknown()`, which gives a model no JSON schema, so the tools declare it explicitly and then hand the values to the route schema.

```ts
// A schedule as a bot writes it. `at` is an ISO 8601 instant with an offset or Z.
const ScheduleArg = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expr: z.string().describe('Five-field cron, e.g. "0 8 * * 1-5" for weekdays at 08:00'),
    tz: z.string().describe("IANA time zone, e.g. Europe/Warsaw"),
  }),
  z.object({ kind: z.literal("once"), at: z.iso.datetime({ offset: true }) }),
]);

// create_routine
{ name: string /* ≤ 80 */, instruction: string /* ≤ 8 KiB */, schedule: ScheduleArg,
  catch_up?: boolean, active?: boolean }

// update_routine: routine_id plus any subset of the editable fields, at least one
{ routine_id: string, name?: string, instruction?: string, schedule?: ScheduleArg,
  catch_up?: boolean, active?: boolean }

// list_routines: no arguments
```

Every tool returns one JSON text result:

```ts
type RoutineOut = {
  id: string;
  name: string;
  instruction: string;
  schedule: { kind: "cron"; expr: string; tz: string } | { kind: "once"; at: string }; // `at` as ISO UTC
  active: boolean;
  catch_up: boolean;
  next_runs: string[]; // up to 3, ISO UTC; empty when paused or finished
  running: boolean;
  last_run: { status: RunStatus; started_at: string; error: string | null } | null;
};
type ToolOut = { now: string /* ISO UTC */; routine: RoutineOut }; // create, update
type ListOut = { now: string; routines: RoutineOut[] }; // list
```

- `now` lets the bot compute a one-time instant. The last run's `output` is left out: it can be long and holds text from outside.
- `next_runs` comes from `routines.preview(schedule)` for an active routine, so the bot can read the next times back to the owner.
- The tool's handler turns `at` into epoch milliseconds, then runs `RoutineInput.safeParse` (create) or `RoutinePatch.safeParse` (update). That is the route schema, so `parseSchedule` decides what is valid: cron and time zone parse, once-in-the-past, never-fires and the 5-minute minimum interval. A failure returns `errorResult("<path>: <message>")`, with the first issue only, so the bot can fix it. Like `handoffs/tools/` and `browser/tools/`, `routines/tools/` has its own small `result.ts` (`errorResult`, `jsonResult`), because a feature may not import another feature's private files.
- The tools call `routines.create(botId, input)`, `routines.update(id, patch)` and `routines.list(botId)`. They never touch `routines/store.ts`.

### Guards

- **Own routines only.** `list_routines` returns `routines.list(ctx.botId)`. `update_routine` first loads the routine with `routines.get(id)` and answers `no such routine` when it is missing or its `botId` is not the caller's. An unknown id and another bot's id get the same answer, so ids are not revealed.
- **Pause is an update.** There is no `delete_routine`, `pause_routine` or `run_routine` tool. `update_routine` with `active: false` pauses, and `true` resumes. Pausing does not stop a run in progress (as with the panel's switch), and the tool description says so.
- **Cap.** `create_routine` refuses when the bot already has 20 routines, whatever their state (`MAX_ROUTINES_PER_BOT`). The message tells the bot to ask the owner to delete one in the panel. The cap applies to the tool only, not to the panel or the HTTP route.
- **No unattended edits.** While `ctx.unattended(botId)` is true (a routine turn or a headless run), `create_routine` and `update_routine` refuse with "scheduled runs cannot create or change routines; ask the user in chat". `list_routines` still works. The check runs on every call, not when the session opens.
- **Field limits.** Name at most 80 characters, instruction at most 8 KiB. These live in the tool schema only.

### Approval-required for writes (reconciling roadmap item 3 with ADR-0009)

Roadmap item 3 says "Bot-created routines default to approval-required for writes (item 1)". Item 1 became [ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md), and it has no per-routine switch. Approval is per tool, per bot (`off`, `ask`, `auto`, and `ask` is the default), and the code keeps no list of which tools write or send. So this guard needs no new flag, and this spec adds none. It is met like this:

1. A bot-made routine runs under exactly the policies of the bot, as one made in the panel does. A write tool left at the default `ask` parks the run and sends the owner a needs-you item. A tool the owner set to `auto` runs without asking, whoever made the routine.
2. The routine tools cannot change a tool policy, a vault grant or an integration. No tool in this endpoint touches them. A bot cannot make a routine more permissive than the owner allowed.
3. A scheduled run cannot create or change routines (above), so a routine cannot spawn routines.
4. The owner can see what the bot made: the routine appears in the Routines panel, and the tool call and its result are in the transcript.

Until ADR-0009's parking lands (`.scratch/10-unattended-parking/`), an unattended write that asks is denied, as today. This feature does not wait for that. The gate check below does not need an approval.

### Time zone

The server may be in UTC (the VPS is). The owner's time zone is not in the host, and the panel gets it from the browser. So the bot must know it:

- `ROUTINES_INSTRUCTIONS` tell the bot: `schedule.tz` must be the owner's IANA time zone. Read it from user memory. If it is not there, ask with `ask_user`, then save it with `remember` (scope `user`). Never guess it from the server or from `now`.
- `tz` is required for cron. It is not defaulted.
- A time the owner gives without a zone ("at 8") means 08:00 in that time zone. For a one-time routine, the bot works out the instant from `now` and the zone, and writes it with an offset.

### Instructions text (`ROUTINES_INSTRUCTIONS`)

Delivered as the MCP server's `instructions` and appended to the system prompt through the lease, as `BOTS_INSTRUCTIONS` is. It says, in short sentences:

- You can set up scheduled routines for yourself with the routines tools (`mcp__routines__*`). Use them when the owner asks for something to happen on a schedule.
- A routine runs later with nobody watching, and it sees only its instruction. Write a self-contained instruction: the goal, where to look, what to produce, and how to end (a summary of at most 5 lines).
- The time-zone rule above.
- After creating or changing a routine, tell the owner its name, the schedule in plain words with the time zone, and the first `next_runs` time.
- To pause, call `update_routine` with `active: false`. You cannot delete a routine; the owner does that in the Routines panel.
- Routines may not ask the owner questions or create routines. Write instructions that need neither.
- You can change only your own routines.

### Contract and web

- No contract change. The `routines` event, `Routine` and `Schedule` stay as they are.
- No web change. `routines.create` and `.update` call `onChange(botId)`, which broadcasts the `routines` event when the bot is the open one. A bot-made routine therefore shows up in the panel by the path that already exists.

## Testing Decisions

- A good test drives the system the way a bot or the owner sees it: a bot calls a tool through the real endpoint, the owner reads `/api/routines/list` or the event stream. Tests do not assert table rows or wrapper text beyond what the bot receives back.
- **Seam 1: the host HTTP seam, bot side.** `startHandoffHost` from `testing/test-host.ts`, with the fake CLI and in-memory database. `actAs(botId)` connects an MCP client to the bots endpoint today; it gains a server name argument (`actAs(botId, "routines")`) so the same helper connects to the routines endpoint. It covers: schemas, validation errors, the cap, own-only access, pause and resume, the unattended refusal.
- **Seam 2: the owner side.** Calls through `host.ui("/api/routines/list", …)` and the event stream read what the bot made, to prove the panel path.
- **Seam 3: a scripted chat turn.** The fake CLI calls a tool on a host MCP server when a message arrives (`rememberOnMessage` and `askOnMessage` are the prior art). It reads the server's URL and token from the MCP config the host gave it, so a passing test proves the lease carries the routines server and the token. The last ticket adds this and the gate check.
- Prior art: `handoffs/guardrails.test.ts` (callers, refusals), `handoffs/handoffs.test.ts`, `routines/index.test.ts` (schedule rules, with a fake clock), `host-server/api/validation.test.ts`.
- Schedule rules are tested once, in `routines/schedule.test.ts`. The tool tests check only that a rule's message reaches the bot.
- `bun run check` is the gate. Coverage floors do not drop.
- The real-model check is a live run on the owner's host. It is the gate check, and it is not part of `bun run check`.

## Out of Scope

- `create_bot` and bot-authored skills (roadmap items 3 and 8). They come after the gate.
- `delete_routine`, `run_routine` (a test run) and a tool to read a routine's run history.
- A per-routine approval flag, a "created by bot" marker or a "needs owner confirmation before it starts" state. Parking covers writes. A marker can come later if I want to see which routines a bot made.
- Time zone as a host or user setting. The bot reads it from user memory.
- Webhook triggers (roadmap item 2). A routine tool for them needs those first.
- The `untrusted` flag. See Further Notes.
- Raising the 20-routine cap in the panel or the HTTP route. The cap is for the tool.

## Further Notes

- **The `untrusted` flag.** [ADR-0009](../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md) says that under `untrusted` every `auto` tool except `mcp__host__*` asks. `create_routine` and `update_routine` are persistent instructions, so injected text in a webhook or email could plant recurring work through them. Because the routine tools are on `mcp__routines__*`, the triggers milestone's rule can cover them without an exception. The triggers milestone should make them ask under `untrusted`. Until then, an event-woken turn (`POST /api/bots/<id>/events`) can call them freely, like every other `auto` tool.
- **Code and plan.** Where the tools live differs from the plan's wording ("host tools", `mcp__host__*`): see "Where the tools live". `canUseTool` already lets `mcp__browser__` and `mcp__bots__` through before any policy, so `mcp__routines__` joins that list; ADR-0009's exemption names only `mcp__host__*`, and the triggers milestone has to decide about the others.
- **Fake CLI.** The fake Claude CLI (`testing/fake-claude.ts`) calls only the in-process `host` server's tools. It reads the MCP config but never calls the HTTP servers. The last ticket extends it.
