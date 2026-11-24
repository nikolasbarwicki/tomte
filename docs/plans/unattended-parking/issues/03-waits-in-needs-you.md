# 03: Open waits count in Needs you

**What to build:** An open human wait raises its bot's Needs-you count in the sidebar, shows in the desktop banner, and is listed in the Needs-you bar with its own buttons. Today the count and the bar read only external events, so a parked run on a bot I have not opened is invisible until I open its chat. See the spec section "Where things live today" (Needs-you).

**Blocked by:** 02

**Status:** done

The pieces: `botsEvent` in `host-server/views.ts` builds each bot's `needsYou`, `needsYouSources` and `needsYouAt` from `Events.needsYou` (`events/store.ts`, `OpenItems`). `Chats.announceBots` rebroadcasts it. The bar is `NeedsYou` in `web/features/chat/needs-you.tsx`, fed by `needsYouItems` in `web/features/chat/model.ts` from the work event. The wait cards already reach the open bot's chat as `wait`, `approve` and `ask` items (`web/host/transcript.ts`). The desktop banner reads only the `bots` slice (`packages/desktop/src/needs-you-banner.ts`), so it needs no change of its own.

- [x] `botsEvent` adds the bot's open human waits (`waits.list`) to `needsYou`, to `needsYouAt` (the newest of both) and to `needsYouSources`. A wait's label is the routine's name when the wait belongs to a run, otherwise its kind ("Approval", "Question", "Takeover"). Opening, answering, expiring and cancelling a wait calls `announceBots` through `waits.subscribe`. The `BotSummary` comment in `packages/contract/src/events.ts` says the count covers waits too
- [x] A linked ask (a question about an external event) is not counted twice: its event is already an item
- [x] The bar lists the open bot's unresolved request cards after its external items, oldest first, each with the card's own buttons and the same cursor. Enter on such a row scrolls to its card and never answers: it must not approve a tool or hand over a browser. `e` does nothing on a wait (a wait has no dismiss; Deny and Skip are its buttons). The bar's count includes them
- [x] The row model stays a pure function in `web/features/chat/model.ts` with unit tests in `model.test.ts`: it builds rows from external items plus unresolved `wait`, `approve` and `ask` items, drops resolved and expired ones, and does not duplicate a linked ask
- [x] The sidebar badge and the bar fall back to zero after the wait is answered on another device, as for external items
- [x] A host-seam test with the fake CLI: a routine parks on a bot that is not open and the `bots` event carries `needsYou: 1` with the routine's name in `needsYouSources`; answering lowers it to 0; an expired park lowers it too. `smoke:needs-you-ui` (or `smoke:answer-ui`) gets one step: an open wait shows in the bar and Enter does not answer it. Run the smoke and record the result under `## Comments`. `bun run check` passes

## Comments

- No schema change, no `SCHEMA_Vn`. `routines.nameOfRun(runId)` is new (the sidebar needs a run's routine name through the module's public surface); `ChatsDeps` gains `routineName`, and `botsEvent` a `WaitCounts` argument.
- Linked ask: the host skips a `question` wait with an `eventId` only while that event is still an open item. A question whose event was dismissed or acted is the only thing left to answer, so it is counted and listed. The bar's model applies the same rule (`needsYouRows`).
- Sources order: a wait newer than every external item is named first, otherwise after the external sources (`Events.needsYou` exposes only the newest arrival time, not one per source). A source is named once.
- The bar's labels are the request's kind ("Approval", "Question", "Takeover"), not a routine's name: the page has no run id. The sidebar and the banner carry the routine's name.
- The bar's request buttons are built in `model.ts` (`RequestRow.actions`): a `wait` card's own actions, an approval's Allow and Deny (`APPROVE_ACTIONS`, one constant to extend for ticket 07's third button, beside `ApproveCard` in `transcript.tsx`), a question's options. A question without options has no button: Show scrolls to its card, where the text field is. Each request row ends in "Show" (Enter) instead of Dismiss. Cards carry the DOM id `card-<id>` (`ScrollerItem` takes an `id`).
- The transcript's `ask` item now keeps its `eventId` (`host/transcript.ts`), which is what the row model needs to drop a linked ask.
- Host-seam tests: `host-server/waits-needs-you.test.ts` (a routine parked on a bot that is not open, answer, expiry through a moved clock and a restart, an attended approval and a page that connects later). The linked-ask no-double-count is held by the existing `ask-event.test.ts` and `needs-you-answers.test.ts` expectations of `needsYou === 1`.
- `smoke:needs-you-ui` has a new step ("an open wait"): the bot's own question shows as a bar row with its option buttons and the sidebar badge agrees (`settled(1)`); Enter and `e` answer nothing; a row button answers it. Results: `bun run smoke:needs-you-ui`, `smoke:answer-ui`, `smoke:blocked-ui`, `smoke:loop-ui` and `smoke:scroll-ui` all passed (the last four because `transcript.tsx` and `scroller.tsx` changed).
- A background-tasks worker's approval is a human wait too, so while open it is now a bar row and a count (`docs/smoke.md` flow 8 says so).
