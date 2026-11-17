# 03: Prove a resumed routine re-arms its schedule without a restart

**What to build:** After an auto-pause (failures, cap, or absence) and a resume, the routine's Bun.cron job must be armed again in the running host. Today that is only shown via restart. Add a test that pauses, resumes, and observes a scheduled (not manual) fire in the same process, using a fake clock or a short cron if the scheduler allows it; fix the re-arm if the test fails. Also cover the spec-literal case where one failure right after a resume pauses again, so the behavior is pinned.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Pause then resume, then a scheduled fire happens without a restart
- [x] A paused routine does not fire on schedule
- [x] The re-pause after one failure post-resume is tested and documented in GLOSSARY or the cost-guards ADR/doc (owner decision: a resume restarts the count, so one failure no longer re-pauses; see Outcome)
- [x] `bun run check` passes

**Outcome:** the gap was not real in code: `update()` calls `arm()` after every resume (the owner's switch and `resumeByReason` both go through it). It was only unproven, because `Bun.cron` cannot be driven from a test (its shortest wait is the next minute, and a mocked system time does not move it). `createRoutines` got a `cron` dependency (default `Bun.cron`) and `routines/index.test.ts` drives it.

The spec-literal case first pinned that a resume did not reset the failure count, so one failed run after a failures resume paused again. The owner decided a resume means "try again": switching a routine back on now stores `routines.failures_from` (schema step V27) and only runs started since then count, so one failure after a resume keeps the routine on and 5 pause it again. The test asserts that; GLOSSARY.md ("Paused routine") and `docs/plans/cost-guards/spec.md` describe it.
