# 03: Open waits count in Needs you

**What to build:** An open human wait raises its bot's Needs-you count in the sidebar, shows in the desktop banner, and is listed in the Needs-you bar with its own buttons. Today the count and the bar read only external events, so a parked run on a bot I have not opened is invisible until I open its chat. See the spec section "Where things live today" (Needs-you).

**Blocked by:** 02

**Status:** ready-for-agent

The pieces: `botsEvent` in `host-server/views.ts` builds each bot's `needsYou`, `needsYouSources` and `needsYouAt` from `Events.needsYou` (`events/store.ts`, `OpenItems`). `Chats.announceBots` rebroadcasts it. The bar is `NeedsYou` in `web/features/chat/needs-you.tsx`, fed by `needsYouItems` in `web/features/chat/model.ts` from the work event. The wait cards already reach the open bot's chat as `wait`, `approve` and `ask` items (`web/host/transcript.ts`). The desktop banner reads only the `bots` slice (`packages/desktop/src/needs-you-banner.ts`), so it needs no change of its own.

- [ ] `botsEvent` adds the bot's open human waits (`waits.list`) to `needsYou`, to `needsYouAt` (the newest of both) and to `needsYouSources`. A wait's label is the routine's name when the wait belongs to a run, otherwise its kind ("Approval", "Question", "Takeover"). Opening, answering, expiring and cancelling a wait calls `announceBots` through `waits.subscribe`. The `BotSummary` comment in `packages/contract/src/events.ts` says the count covers waits too
- [ ] A linked ask (a question about an external event) is not counted twice: its event is already an item
- [ ] The bar lists the open bot's unresolved request cards after its external items, oldest first, each with the card's own buttons and the same cursor. Enter on such a row scrolls to its card and never answers: it must not approve a tool or hand over a browser. `e` does nothing on a wait (a wait has no dismiss; Deny and Skip are its buttons). The bar's count includes them
- [ ] The row model stays a pure function in `web/features/chat/model.ts` with unit tests in `model.test.ts`: it builds rows from external items plus unresolved `wait`, `approve` and `ask` items, drops resolved and expired ones, and does not duplicate a linked ask
- [ ] The sidebar badge and the bar fall back to zero after the wait is answered on another device, as for external items
- [ ] A host-seam test with the fake CLI: a routine parks on a bot that is not open and the `bots` event carries `needsYou: 1` with the routine's name in `needsYouSources`; answering lowers it to 0; an expired park lowers it too. `smoke:needs-you-ui` (or `smoke:answer-ui`) gets one step: an open wait shows in the bar and Enter does not answer it. Run the smoke and record the result under `## Comments`. `bun run check` passes
