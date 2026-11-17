# 01: Meter the front chat turns of double-loop bots

**What to build:** A double-loop bot's front chat thread does not go through the `meter` collaborator on `ThreadEnv`, so its turns never update `session_usage_marks` or count anywhere. Route the front thread's success (and error) results through the same meter as every other `Thread.send` caller, so its session mark stays current and a later routine run in a shared session is not charged for front turns.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Front chat turns of a double-loop bot call the meter and update the session's mark
- [x] A routine run after front chat turns is charged only its own difference (a double-loop run never shares the front's session, so this holds by separate session marks; the test proves it end to end)
- [x] Test at the host HTTP seam with the fake CLI and a double-loop bot. `bun run check` passes
