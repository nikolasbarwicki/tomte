# 04: Parked time is recorded and does not count against the cap

**What to build:** When a run parks at a human wait, its run clock stops and its parked time is recorded; when the run resumes, the clock goes on. A 03:00 run that waits until 07:00 then keeps its full 30 minutes, and the run history shows how long it waited. See the spec sections "Run usage" and "Time cap", and [ADR-0009](../../../docs/adr/0009-unattended-runs-park-on-durable-human-waits.md).

Read spec 10, ticket 02 first and hook into the two points it defines: where a run enters `waiting` and where it leaves it (an answer resumes it by a message, or the 24 hour expiry fails it). A parked run's turn has ended, so the executor is not running; the resume turn is a new turn in the same session. Its usage must be added to the same run, not a new row. The `human_waits` row already has the run id, so a resume turn can name its run.

**Blocked by:** [01](01-run-usage.md), [02](02-run-time-cap.md), [spec 10 ticket 02](../../10-unattended-parking/issues/02-parked-runs.md)

**Status:** ready-for-agent

- [ ] On entering `waiting`, the run's clock pauses and the park start is kept. On leaving it, by an answer or by expiry, the elapsed park time is added to `routine_runs.parked_ms` and the clock resumes (an answer) or is cleared (an expiry, which fails the run as spec 10 defines)
- [ ] A run parked for longer than the cap is not failed by the cap after it resumes. Its active time since the resume still counts, so a hung resume fails at the cap's remainder
- [ ] A park that was open when the host restarted is reconciled: its `parked_ms` includes the time up to the restart and from the restart on, as the durable wait's age shows. The clock after a restart starts from the active time already used. The 24 hour expiry from spec 10 still applies
- [ ] The resume turn's usage is added to the run's token and cost columns (running total, not replacement). The turn's metering from ticket 01 already keeps the session mark current
- [ ] `parkedMs` is returned in the run history, and a run that is currently `waiting` includes the time parked so far. The web run row from ticket 01 shows it
- [ ] The failure count of ticket 03 does not count a `waiting` run. A run that was parked and then expired (`failed`) counts as a failure
- [ ] Tests at the `createRoutines` seam with the fake clock: park for 2 hours with a 30 minute cap and no expiry; `parked_ms` is 2 hours and the run succeeds. A park then a hung resume fails 30 minutes of active time after the resume. At the host HTTP seam, with the fake CLI: a routine parks at an approval, the approval is answered later, the run finishes, and its usage covers both turns. `bun run check` passes
