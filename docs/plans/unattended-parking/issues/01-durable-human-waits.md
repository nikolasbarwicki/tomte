# 01: Durable human waits

**What to build:** Every human wait (a tool approval, an `ask_user` question, a takeover, a login approval) becomes a row in a new `human_waits` table, in a new `waits` feature module. The in-memory stores go away: `chat.pending` in `host-server/chats.ts` and `browser/human-waits.ts`. An open wait survives a host restart, and an answer after a restart reaches the bot as a message. Nothing parks yet; that is ticket 02. See the spec sections "The `waits` feature module" and "Where things live today".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

How today's waits work, so you can keep their behaviour:

- `ask` and `approve` cards are `chat.pending` entries. The tool call waits for the resolve function (`waitForUser` in `chats.ts`, `delegate.askUser` and `delegate.approve` in `host-server/threads.ts`). A linked ask (an `event_id`) is dropped when its turn ends (`dropLinkedAsks`). Keep that.
- `wait` cards (takeover, login approval) come from `createHumanWaits` in `browser/human-waits.ts`. Each spec has two closures, `resume` and `onResolve`. Closures cannot be stored, so replace them with one handler per kind that works from the stored payload.
- `Takeover` (`browser/takeover.ts`) and `createBrowserLogin` (`browser/login.ts`) call `waits.request`, `waits.resolve`, `waits.answer` and `waits.cancelBot`. `login.ts` keeps an in-memory `asking` set.
- `browser/ui-routes.ts` answers wait cards at `/api/waits/answer`. `host-server/api/chat.ts` answers asks and approvals at `/api/answer` through `Chats.answer` (`answerAsk`). Both routes stay. Both now resolve through the one module.

- [x] A new append-only schema step in `platform/db.ts` (the next free `SCHEMA_Vn`; do not edit an earlier step) creates `human_waits`: `id`, `bot_id`, `kind` (`tool_approval`, `question`, `takeover`, `credential`), `run_id` (null for now), `session_id`, `payload` (JSON), `actions` (JSON `WaitAction[]`), `state` (`open`, `answered`, `expired`, `cancelled`), `outcome`, `note`, `created_at`, `expires_at`, `resolved_at`, `consumed_at`. No foreign key to `routine_runs` (ticket 02 rebuilds that table)
- [x] A new folder `packages/host/src/waits/` (`index.ts` interface, `store.ts` with the SQL) is added to the module list in `.dependency-cruiser.cjs`. `browser/human-waits.ts` is deleted and the browser takes the module as a collaborator. The composition root (`host-server/index.ts`) builds it and passes it to the browser, chats and `removeBot`
- [x] The interface has `open(botId, spec)` (stores the row, shows the card, returns `{status: "waiting_for_user", id}`), `answer(id, value, note?)`, `resolve(id, outcome)` (outcomes `timeout`, `expired`, `cancelled`), `cancelBot(botId, reason)`, `list(botId?)` (open waits, oldest first), `subscribe(listener)` (told when a wait opens and when it closes) and `cards(botId)` (open cards to replay). The feature `.scratch/11-telegram-channel/` uses these names
- [x] Each kind registers a handler: the card event from the payload, the bot's message for an outcome (with the owner's note when there is one) and an effect on resolve (the credential grant, the takeover release). The existing cards do not change: `approve` and `ask` close with `answered`, `wait` closes with `wait_resolved`. The contract does not change
- [x] An approval or a question asked in an attended turn is still awaited in the same process. When no continuation exists (the host restarted, or the turn ended), the answer is delivered to the bot's session as a message through `deliver()`
- [x] A linked ask still expires when its turn ends: its row becomes `cancelled`, its card shows `ask_expired`, and a late answer closes nothing. `pendingAskFor` and `answerAsk` behave as today, reading the table
- [x] The bot's message is `<human-wait-result id="…">…</human-wait-result>` for every kind. `<browser-wait-result>` is gone, including in `browser/smoke.ts` and the tests that match it
- [x] An `allow` answer to a `tool_approval` keeps the tool and its canonical input. The next `canUseTool` call by that bot with that tool and exactly that input is allowed once and marks the row `consumed_at`. A call with other input asks again. The resume message tells the bot to call the tool again with that exact input
- [x] Every wait has `expires_at`, 24 hours after it opened. A timer and a start-up sweep resolve an overdue wait as `expired` and tell the bot. The module takes a `now` option (as `createDeviceAuth` does) so tests move the clock. A takeover keeps its own 30-minute inactivity limit as `timeout`
- [x] The credential approval no longer uses the in-memory `asking` set in `browser/login.ts`: a second `browser_login` while a `credential` wait for that bot and entry is open answers "not answered yet", from the table
- [x] After a restart, open `tool_approval`, `question` and `credential` waits stay open and replay as cards when the bot's chat is built (`createChat` calls `cards(botId)` where it called `pendingWaits`). An open `takeover` wait is resolved as `cancelled` with a message that says the browser session is gone, so the bot can ask again
- [x] `cancelBot` and a new session (`api/chat.ts` calls `browser.cancelTakeover`) still cancel a bot's open waits and tell the bot. Deleting a bot removes its rows (`browser/cleanup.ts`, `removeBot` in `host-server/index.ts`)
- [x] `testing/fake-claude.ts` can ask for a tool permission: an optional `approve.json` (`{ tool, input }`) makes each user message send a `can_use_tool` control request and record the response, as `ask.json` does for `ask_user`. Its header comment says so
- [x] Host-seam tests (prior art: `browser/takeover.test.ts`, `host-server/ask-event.test.ts`, `handoffs/durability.test.ts`): an approval card appears for a tool with the `ask` policy and `allow` and `deny` each reach the tool; an `ask_user` card survives `restart()` and its answer then reaches the session as one message; a credential approval answered after `restart()` creates the grant and tells the bot; a takeover wait is cancelled by `restart()` and the bot is told; an `allow` covers one call with the same input once, and a second call or other input asks again; a wait overdue by 24 hours (moved clock) expires and the bot is told; deleting a bot removes its waits; `/api/answer` and `/api/waits/answer` still refuse a stale id. `bun run check` passes

## Comments

Implemented with these differences from the ticket text:

- `waits` owns state, chats owns continuations. Chats keeps a map from wait id to resolver for the attended turn and gives `waits` a `claim(wait, text)` hook. When the hook claims a closed wait the tool call resumes in-process and no message is sent; otherwise the message goes through `deliver()`. Continuations are dropped when a standard turn ends or the sessions close, so a later answer goes by message.
- A linked ask (one with an `event_id`) is also cancelled silently (`ask_expired`, no message) when the host restarts or the session closes, not only when its turn ends. A late answer closes nothing.
- An in-process `deny` still reaches the SDK as `user declined` (plus the owner's note); a cancelled or expired approval carries the framework's text.
- An `allow` answered in-process is consumed at once. Only an `allow` that no continuation awaited stays `answered` with `consumed_at` NULL until the next call with that exact input (compared by key-order-independent canonical JSON).
- The 24 h timer is a real-time 60 s interval plus the sweep at start-up; tests expire waits by moving `now` and restarting (or answering late, which resolves the wait as `expired`).
- `/api/answer` answers only `question` and `tool_approval` waits and `/api/waits/answer` only `takeover` and `credential` waits. Both resolve through `waits.answer`.
- `Waits` also exposes `register`, `find`, `consumeApproval`, `removeBot`, `start` and `close`, beyond the names the ticket lists.
- Schema step: `SCHEMA_V16`.
- `smoke:answer-ui` was not run: the web app and the relay are unchanged.
