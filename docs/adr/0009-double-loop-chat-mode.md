# 0009: Double-loop chat mode is a per-bot second chat mode, run by a long-lived front session and background agents

Status: accepted. Relates to [ADR-0002](0002-bot-handoffs-are-async-a2a-tasks-on-a-host-endpoint.md) (handoff results arrive through `deliver()`), [ADR-0003](0003-feature-modules-and-dependency-rules.md) (the new host feature module) and [ADR-0004](0004-web-feature-modules-and-host-store.md) (web feature modules and the host store). The spec is `docs/plans/double-loop-chat.md`; the prototype is `../double-loop/v3`, its design `../double-loop/docs/double-loop-design.md` (§ "v3 as built") and its plan `../double-loop/docs/v3-plan.md`.

## Context

A bot's chat is turn-based: `Thread` holds one SDK `query()` per bot, `Chat.busy` allows one turn at a time, and a message sent mid-turn is queued and drained into the next turn. Heavy work (research, file edits) therefore blocks the conversation for minutes.

The prototype in `../double-loop/v3` showed another shape on the same Claude Agent SDK: one long-lived, fast **front** session answers every message within seconds, and heavy work runs in **background agents** the front starts, steers and stops. Its runs show front replies in 0.7 to 3.4 s with an agent running, a steer changing a running agent's scope, three agents in parallel, a `kill -9` with two agents running followed by a resume, and a worker's file tools refused outside its workspace. They also show tasks that fail to start and a stop that misses its id, which the port must handle.

## Options

Only the decisions with a real alternative are listed; the rest are taken from the spec as written.

- **Toggle scope.** Per bot, or a global `HostConfig` flag. A global flag forces one mode on every bot, cannot be flipped from the UI, and would also need a new-bot field.
- **Switching modes.** Continue the CLI session in the other mode, or start a new session. The modes use different system prompts, agent definitions and session shapes; continuing mixes them.
- **Task log.** SQLite tables, or JSONL per bot as in v3. The host already has a migration mechanism and `bot_activity` and `handoffs` as precedents.

## Decision

The double-loop chat mode is added as a second mode beside the unchanged standard chat, with these decisions:

1. **Toggle scope: per bot.** `Bot.chatMode: "standard" | "double_loop"`, default `"standard"`, carried on `BotSummary` and stored in `bot.json` (`StoredBot`, preserved by `save()` as `browser` is). Rejected: a global `HostConfig` flag.
2. **Switching starts a new session.** It calls `newSession` and is refused with 409 while double-loop agents are running or queued; the UI says to stop the running tasks first.
3. **Durable task log in SQLite.** Tables `loop_tasks` and `loop_events` (migration `SCHEMA_V14`), keyed by bot and session: task lifecycle, progress, activity, steers and reports. Reports never enter the front's CLI session, so `replay()` cannot rebuild them from the session file; in double-loop mode replay merges the session file with `loop_events` by timestamp. Rejected: JSONL per bot.
4. **Replay strips app-written blocks.** User messages in the front session end with `<work_state>…</work_state>`, and synthetic app messages (queue dispatch, restart notice, task notifications) are `isSynthetic`. Replay drops both, so the transcript shows what the user typed and what the bot said.
5. **Front tool set.** `Agent`, `SendMessage`, `TaskStop`, `mcp__loop__queue_task`, `mcp__loop__cancel_queued`, `mcp__host__remember` and `rewrite_memory`. No `ask_user`: a blocking ask would stall the never-blocking front, so the front asks in chat. As in v3 the main thread runs as a `front` agent whose tool list is that set, and the session's `tools` hold every agent's tools, because subagents only see what the session has.
6. **Agent types.** `researcher`: WebSearch, WebFetch, `record_progress`. `worker`: the bot's own capabilities (file tools in the bot's workspace, Bash under the bot's isolation profile, the bot's integration MCP tools, `mcp__host__ask_user`, `record_progress`). Browser tools stay off agents: the browser session is one per bot and parallel agents would fight over its tabs. Handoff tools (`mcp__bots__*`) stay on the front, so a handoff result returns through `deliver()` into the front.
7. **Permissions keep Claudebot's rules.** `Thread.canUseTool` and the `HostDelegate` are reused. A background agent's approval or `ask_user` raises the normal approve/ask card, a needs-you item; that agent waits while the front and the other agents continue. v3's `permissionMode: "dontAsk"` is not ported, because a human is present. v3's PreToolUse path guard stays as defence in depth for the worker.
8. **`deliver()` in double-loop mode** pushes a synthetic message (`isSynthetic: true`, `priority: "next"`) into the front instead of queueing a turn. This covers handoff results, external events, browser waits and routine prompts. Routine runs on a double-loop bot without a chat use the standard headless runner (`runHeadless`) unchanged.
9. **No composer queue.** In double-loop mode `/api/send` always answers `outcome: "sent"`; `queued`, `dequeued` and `/api/send/cancel` do not apply. Answers to needs-you items (`eventId`) keep their path: a linked ask is answered directly, otherwise the message goes to the front.
10. **Presence instead of a per-turn "is working…".** `BotSummary.status` is `working` while the front's turn or any agent runs. The transcript shows one presence line: "typing…" while the front streams, "working…" while agents run. Front text streams through `text_start` and `delta`; reports appear whole.

**What a task is.** A background task is what the front starts with the Agent tool; its result is a report, posted to the chat as the bot's own message, after which the front adds one line about what is still running. The app writes a work state into every message the front receives, and findings are attributed to tasks by the app, not by the agent.

**Architecture.** A new host feature module `packages/host/src/loop/` with a public surface of `index.ts` only, wired in the composition root `host-server/index.ts`. `loop` is added to `MODULES` in `.dependency-cruiser.cjs` when its code lands.

| File            | Owns                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `front.ts`      | `FrontSession`: shaped like `Thread`, but a pump consumes the query iterator for the session's whole life, not per turn                   |
| `agents.ts`     | agent definitions and prompts, `ProgressAttribution`, the in-process `loop` MCP server (`record_progress`, `queue_task`, `cancel_queued`) |
| `observe.ts`    | SDK messages and hooks → store rows and `ServerEvent`s through a callback the chat supplies                                               |
| `tasks.ts`      | task registry folded from the log, app queue (`after`), dispatch and re-dispatch                                                          |
| `work-state.ts` | `workState()`, pure                                                                                                                       |
| `store.ts`      | SQLite access for `loop_tasks` and `loop_events`                                                                                          |

Chat mode dispatch lives in `host-server/chats.ts` (`send`, `deliver`, `reconfigure`, `drop`, `newSession`, `replayOpen`, `isWorking`). New `ServerEvent`s: `task`, `task_status` (ephemeral, not in history) and `report{taskId, text}`.

**Risk handling.**

- **`TaskStop` is a shell tool here.** `SHELL_TOOLS` in `harness/index.ts` contains it, and `isolation.shell === "disabled"` denies it session-wide, so an isolated double-loop bot could never stop an agent. In double-loop mode `TaskStop` is removed from the session-wide deny list, and a PreToolUse hook refuses `TaskStop` when its `task_id` is not a background agent the store knows. `shell-isolation.test.ts` pins the list and is updated as a contract test.
- **Nothing closes a front with running agents.** Closing the front kills every agent. Idle close (`idleMs`), `configStale` after `reconfigure()`, and integration token expiry defer until no agent runs. The front's pump never closes on a send error, unlike `Thread.send`.
- **Busy semantics stay.** Standard `busy`, `inbox` and `drain` are untouched; a double-loop chat bypasses them rather than overloading them.
- **Context growth.** Reports stay out of the front's context, as in v3; auto-compaction handles the rest and `compacted` events already render.
- **Subscription limits.** Parallel agents share the user's 5-hour and weekly limits. `rate_limit_event` (status, utilization, reset) is surfaced next to the context meter when the bot is in double-loop mode.
- **CLI-version drift.** Background tool filtering, task events and `SendMessage` resume have changed across recent Claude Code versions. The managed CLI version is pinned in `harness/cli.ts`; rerun the routing eval and a manual restart test when bumping it.

**Defaults.** Front: `claude-haiku-5-5` with `thinking: {type: "disabled"}`; other models at `effort: "low"`. Agents: `claude-sonnet-5-5` at `medium` effort, `maxTurns` 60 (researcher) and 80 (worker). `MAX_PARALLEL` is 3, set through `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. The environment sets `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`; options set `agentProgressSummaries: true` and `includePartialMessages: true`. Unprompted progress pings are off.

**Non-goals.** v3's devtools page, trace rows and SDK cost estimate; unprompted progress updates; browser tools on background agents; a double-loop variant of headless routine runs; multiple front sessions per bot.

**SDK version.** The installed `@anthropic-ai/claude-agent-sdk` is 0.3.318 and v3 ran on 0.3.322. Comparing the two `sdk.d.ts` files, the definitions the port depends on are identical apart from comments and whitespace: `SDKTaskStartedMessage`, `SDKTaskProgressMessage` (including `summary`), `SDKTaskNotificationMessage`, `SubagentStopHookInput.last_assistant_message`, `agentProgressSummaries`, `AgentDefinition.background`, `SDKUserMessage.isSynthetic` and `priority`, `PreToolUseHookInput` and `SDKRateLimitEvent`. The files differ elsewhere (comment text and additions to unrelated control requests and options), none of which the port uses. There is no SDK bump for this feature; re-check when the managed CLI version in `harness/cli.ts` is bumped.

**Evaluation.** The routing eval result and manual real-CLI timings are recorded in M7.

## Consequences

- Both modes stay supported: the standard chat and its tests are unchanged, and every `chats.ts` path that touches `busy`, `inbox` or `drain` needs a mode branch.
- A double-loop bot's transcript is no longer rebuilt from the CLI session file alone; `loop_events` is part of what replay reads, and a lost or reset database loses reports.
- Switching modes loses the continuity of the conversation (a new session) and is blocked while tasks run.
- A task that waits on an approval or `ask_user` card holds one of three parallel slots until the user answers.
- Agents cannot use the browser, so browsing work stays with standard mode or the front's handoffs until the browser session has a lock.
- Parallel agents spend the subscription faster; the rate-limit display is the only guard.
- Fake-CLI tests cannot drive the mode until `testing/fake-claude.ts` is extended, which is scheduled with the first agent milestone.
