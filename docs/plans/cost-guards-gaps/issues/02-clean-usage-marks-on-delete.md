# 02: Delete usage marks with their bot

**What to build:** Deleting a bot leaves its rows in `session_usage_marks`. Remove them in the same transaction as the bot's other session data. If the cleanup needs a schema change, add a new append-only step after the current last one (V25 at the time of writing); never edit an earlier step.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Deleting a bot removes every `session_usage_marks` row for its sessions
- [x] Other bots' marks are untouched
- [x] Test through the bot-delete API (wait on `host.server.isWorking(bot)` before deleting, as the other load-race tests do). `bun run check` passes
