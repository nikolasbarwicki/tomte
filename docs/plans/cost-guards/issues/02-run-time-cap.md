# 02: A 30 minute cap on every run

**What to build:** A routine run that has worked for 30 minutes fails, so a hung or looping run frees its Chrome and memory. The clock counts active time only and can be paused; ticket 04 pauses it while a run is parked. See the spec section "Time cap".

In `routines/index.ts`, `run()` already holds the live run's `stop` (`LiveRun.stop`, set from the `Executor`). The cap calls it. Both stops end by closing the thread (`runHeadless` calls `thread.close(reason)`; the chat path calls `chat.thread.close(reason)`), and `Thread.send` then throws "Claude Code exited before the turn produced a result". So the run must remember that it expired and record the limit as the error, not the thread's message.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `createRoutines` takes `runCapMs` (default 30 minutes). A run clock with `pause()`, `resume()` and `clear()` starts with each run, counts active time, and at the cap calls the run's `stop`
- [x] An expired run ends `failed` with "run exceeded the 30 minute time limit" (the real cap in the text), whatever error the stopped executor throws. It frees `running` for the routine and calls `onChange`
- [x] A run that finishes first, fails first, or is stopped by `remove()` or shutdown clears its clock and keeps today's handling. No timer outlives its run
- [x] A manual run has the same cap as a scheduled one
- [x] The routine's next occurrence after an expired run starts normally
- [x] A short comment on the clock says it is the one place that counts active time, so ticket 04 has one seam to pause
- [x] Tests at the `createRoutines` seam with a small `runCapMs` and an injected `Executor`: a run that never settles fails at the cap with the message; a run that ends before the cap is unaffected and leaves no pending timer; an executor whose `stop` rejects with another message still records the limit message; a clock paused for longer than the cap does not expire (the unit seam of ticket 04). `bun run check` passes
