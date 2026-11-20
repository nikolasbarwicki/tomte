# 01: Any bot creates a bot after approval

**What to build:** Every bot gets `create_bot(name, purpose, memory?, chat_mode?)` on the bots endpoint. Each call raises the normal tool approval card, and the bot exists only after the owner approves. Spec `../spec.md`, "`create_bot` for every bot". Port from `feat/primary-bot` (`e3110e7`, `b666cd8`) without the role gate.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `createBot(dataRoot, name, purpose, id, avatar, memory)` writes an optional memory seed to the new bot's memory file; blank writes nothing. `/api/bots/new` is unchanged.
- [x] `create_bot` is registered for every bot. `BotsToolContext` gains `unattended()` and `createBot(spec)`; there is no `isPrimary()`.
- [x] Guards, in order: refused in a scheduled run; name at most 80, purpose required and at most 400, memory at most 1200 characters; refused when the host has 20 bots. The new bot has the browser off, `chatMode` from `chat_mode` (default `standard`) and `chiefOfStaff` false. The owner's open chat does not move.
- [x] `ALWAYS_ASK_TOOLS` holds `mcp__bots__create_bot`. `createCanUseTool` checks it before `approveAll`, stored allowances and the `mcp__bots__` prefix. `approvalActions` offers no `allow_always` for it, and `/api/answer` refuses that action with 404. Unattended (`HostDelegate.attended()` false), it is denied at once, with no card and no wait.
- [x] The double-loop front's bots lease is `attended`.
- [x] `BOTS_INSTRUCTIONS` gains one `create_bot` line: propose only when no bot fits, say why, wait for approval.
- [x] The fake CLI's `httpTool` loop step asks permission before calling the HTTP tool, as the real CLI does.
- [x] Tests (port `handoffs/create-bot.test.ts`, `bots/can-use-tool.test.ts`, `host-server/bot-memory-seed.test.ts` as a `createBot` test, removing primary cases): card with exact arguments and no always-allow; approve, deny; seed; browser off; `chat_mode`; cap; argument refusals; double-loop front; chat-hosted routine turn and headless run denied with no wait; the card on the fake Bot API.
- [x] `AGENTS.md` describes `create_bot` and the fixed ask; `docs/roadmap.md` item 3 records `create_bot` as landed for every bot.
- [x] `bun run check` passes.
