# 04: Gate check: "brief me every weekday at 8" creates the routine

**What to build:** Close gate step 4. A chat message that asks for a recurring job makes the bot create a routine through the routine tools, and the routine appears in the Routines panel. This ticket adds the scripted chat test that proves the wiring end to end, the docs, and the live check on the owner's host. See the spec sections "Testing Decisions", "Time zone" and "Approval-required for writes".

**Scripted chat turn.** The fake Claude CLI (`testing/fake-claude.ts`) calls only the in-process `host` server's tools today. It reads the MCP config the host gives it (`mcpServers`, with the URL and bearer token of every host server) but never calls the HTTP ones. Add the missing piece, shaped like `rememberOnMessage` and `askOnMessage`:

- `callOnMessage(server, tool, args)` in `testing/test-host.ts` makes the fake CLI, on each message it receives, post a JSON-RPC `tools/call` to that server from its own MCP config, with the token as a bearer header, and record the result text in `toolResults()`.
- `stopCalling()` ends it, as `stopAsking()` does.

**Docs.** `docs/roadmap.md` item 3: mark `create_routine`, `list_routines` and `update_routine` as shipped and served at `/mcp/routines` (`mcp__routines__*`), and replace "Bot-created routines default to approval-required for writes (item 1)" with the reconciliation from the spec: no per-routine flag, the bot's own tool policies apply and an `ask` write parks (ADR-0009), the tools cannot change a policy or a grant, and a scheduled run cannot create or change routines. Say that `create_bot` and the Chief of Staff template are still open. The "Done when" line stays. If a doc describes the bot-facing tools (README or `docs/`), name the routine tools next to the handoff tools. Check ADR-0001's line "In-process tools stay for `ask_user`, `remember` and `rewrite_memory` only"; it stays true.

**Live check (the owner runs it).** On the VPS host, or the laptop host, with the real Claude CLI:

1. User memory holds the owner's time zone ("Time zone: Europe/Warsaw"). Or the bot asks once with `ask_user` and saves it with `remember` scope `user`.
2. In a bot's chat, type "brief me every weekday at 8".
3. The bot calls `create_routine` and answers with the name, "weekdays at 08:00 (Europe/Warsaw)" and the next run.
4. The Routines panel shows the routine, active, with cron `0 8 * * 1-5`, without a page reload and without touching the UI.
5. Type "pause the weekday brief". The panel shows it paused. Type "resume it". It is active again.
6. Open another bot and ask it to list its routines: it does not see the first bot's routine.

Record the result under `## Comments` at the bottom of this file, with the date and which host.

**Blocked by:** 02, 03

**Status:** done

Everything automated is done (the test host helpers, the scripted chat tests in `packages/host/src/routines/gate-check.test.ts`, the docs). Only the live check above is open: it needs the real Claude CLI on the owner's host, which an agent does not run.

- [x] `callOnMessage` and `stopCalling` exist in the test host, with prior art `rememberOnMessage`/`askOnMessage`, and are used by the tests below
- [x] Gate test: a chat message sent through `/api/send` to an open bot makes the fake CLI call `create_routine` on the routines server from the CLI's own MCP config (cron `0 8 * * 1-5`, the time zone the test put in user memory). The routine is in `/api/routines/list`, and a `routines` event reached the stream. The CLI's launch record shows the `routines` server and its instructions
- [x] Pause test: a second scripted call of `update_routine` with `active: false` makes the panel's list and the stream show the routine paused
- [x] Guard tests at the same seam: one bot cannot list or update the other's routine through its own CLI config; a scripted call made while the bot runs a routine turn is refused and creates nothing
- [x] A scripted turn where the bot calls `create_routine` with a bad schedule gets the route's error text back in `toolResults()`, and creates nothing
- [x] `docs/roadmap.md` item 3 is updated as above
- [x] Live check steps 1 to 6 are done by the owner and recorded in Comments. An agent leaves this box unticked, says so in its report, and marks the gate-step-4 check as waiting for the owner
- [x] `bun run check` passes

## Comments

- 2026-11-19 (VPS `vps.tail3b8f5e.ts.net`, fresh `tomte` install, Claude CLI `2.1.328`):
  - Set user memory `Time zone: Europe/Warsaw`.
  - Sent `"brief me every weekday at 8"` to scratch bot `e5402ab2` → created routine `74fbf034` (`"Weekday 8:00 briefing: weather and day plan"`, `0 8 * * 1-5`, `Europe/Warsaw`, `active: true`).
  - Sent `"pause the weekday brief"` → `active: false`.
  - Sent `"resume it"` → `active: true`.
  - Asked second scratch bot `b28f1043` `"list your routines"` → `[]` (isolated).
  - Cleaned up both scratch bots.
