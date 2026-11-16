# 01: Run usage: tokens, estimated cost and parked time on every run

**What to build:** Every routine run row stores what the run used, and the run history shows it. This is the tracer bullet: run a routine, then read its tokens and estimated `total_cost_usd` in the Routines panel. See the spec section "Run usage".

What the code does today (the plan says otherwise): `Thread.send` in `bots/thread.ts` already returns the SDK's whole result message in `TurnResult.result`. The drop happens in the callers: the `Executor` type and `runHeadless` in `routines/index.ts` return only `.text`, `routine-turns.ts` resolves `r.text`, and a failed turn throws before any usage is read.

Two SDK facts shape the work. `total_cost_usd` and `modelUsage` are cumulative across a live session's turns, and a resumed session's first result already includes its earlier turns, so a run's usage is a difference against the last total the host saw for that session. `usage` is per turn but covers the main loop only, so tokens come from the sums of `modelUsage` to agree with the cost.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A new append-only schema step creates `session_usage_marks` (session id, cumulative cost, cumulative input, output, cache-read and cache-creation tokens, updated at) and adds nullable `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `total_cost_usd` and `parked_ms INTEGER NOT NULL DEFAULT 0` to `routine_runs`. No earlier step is edited
- [ ] `ThreadEnv` gets a `meter` collaborator and `Thread.send` calls it with every success result, from every caller (chats, headless runs, handoff threads). `TurnResult` gains `usage: TurnUsage | null`, the turn's difference from the session's saved mark. The mark is updated on every turn, so a chat turn between two routine runs is never counted in the second run
- [ ] A session with no mark and a thread that was not resumed starts from zero. A resumed thread with no mark gives `null` for that turn and saves the mark. A total below the mark counts from zero
- [ ] An error result (`subtype !== "success"` or `is_error`) makes `Thread.send` throw a `TurnError` that carries the turn's usage, so a failed run keeps what it cost
- [ ] `Executor.done` resolves to the final text and the turn's usage; `runHeadless`, `routine-turns.ts` (headless and in-chat) and `routines/index.ts` pass it on. `run()` writes the usage with `finishRun`, for `succeeded` and for `failed`
- [ ] `RoutineRun` in `packages/contract/src/events.ts` gains `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, or `null`), `costUsd` (number or `null`) and `parkedMs`. `routines/store.ts` `RunRow` and `toRun` map them. `parkedMs` is 0 until ticket 04
- [ ] `testing/fake-claude.ts` emits a cumulative `total_cost_usd` and `modelUsage` that a test can set per turn (a file in its state directory, as `result.txt` does)
- [ ] The run history in `packages/web/features/routines/routine-item.tsx` (`RunRow`) shows tokens, "est. $x.xx" and parked time when above zero. A run without a number shows nothing for it. The text says "estimated"
- [ ] GLOSSARY's **Run usage** entry matches what is stored, including that cost is a per-run difference. The spec's code-versus-plan note stays in the spec
- [ ] Tests at the `createRoutines` seam: a run's usage is written for success and for failure, and `null` usage stays `null`. Tests at the host HTTP seam with the fake CLI: two routine runs in one session each show their own cost, not the running total; a chat turn in between is not charged to the next run; a resumed session with no mark gives an unknown first cost and exact later ones; `/clear` (a lower total) does not give a negative cost. `bun run check` passes
