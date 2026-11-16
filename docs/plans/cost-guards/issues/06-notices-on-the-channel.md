# 06: Notices reach my phone, and channel actions count as presence

**What to build:** Once the channel interface exists, an auto-pause or absence notice arrives on the channel like any needs-you item, and a message or button press from the linked owner counts as presence for the absence pause. This is the last piece of the gate's cost-guard check: a looping routine pauses itself and tells me, on my phone. See the spec section "Delivery to a channel" and [ADR-0010](../../../adr/0010-channels-deliver-needs-you-items.md), which has a channel send every needs-you item, an expired park, a failed run and an auto-pause.

Notices are open needs-you items (ticket 03), so the channel's delivery of open items should carry them without a special case. Read spec 11, ticket 01 for the interface: this ticket uses it and does not change it. If the interface delivers only the item kinds it knew when it was written, make it deliver `notice` through the same path, not a second one.

**Blocked by:** [03](03-auto-pause-after-failures.md), [05](05-absence-pause.md), [spec 11 ticket 01](../../telegram-channel/issues/01-channel-interface-and-link.md)

**Status:** done

- [x] A `notice` item (auto-pause, absence warning, absence pause) is delivered to a linked channel through the same path as other open needs-you items. It shows its title and body and a link to the web UI, and offers Dismiss only. Dismissing it on the channel closes it through the answer path, and it closes in the web UI too
- [x] A notice closed as `resolved` (a routine resumed, the owner returned) is closed on the channel too, in whatever way the interface closes any item that left `open`
- [x] A message or button press from the linked owner account calls presence's `touch`. An update from an account that is not linked does not (the channel already ignores it). Free text with no open card is still a presence touch: the owner is there
- [x] The gate check passes with a fake channel adapter at the host seam: a routine that always fails pauses itself after 5 runs and the adapter receives the notice; with `--pause-after-absence-days` set, the adapter receives the warning and then the pause notice; a message from the linked account resumes the absence-paused routines; a message from another account does not
- [x] The channel interface needs no new method for notices. If it does, say so under `## Comments` before changing it
- [x] Where the channel's documentation lists what it sends, auto-pause and absence notices are named
- [x] Tests at the host HTTP seam with the fake adapter as above. `bun run check` passes

## Comments

- The channel interface needed no new method. Two gaps were in the host, not the interface: `Events` raised a notice with `onChange(botId, [])` (a notice leaves no transcript row), and the composition root synced cards only when `changed` was not empty, so a notice never got a card and a dismissed or resolved one never had its card edited. The root now syncs on every `Events` change (sync is serialized and idempotent).
- A reply to a notice card used to reach the bot: the event source answered it through `Chats.send` with the item's id. `createEventCards` now refuses a reply for kind `notice`.
- The card's link for a notice opens `?panel=settings&section=routines` (the conservative choice after the navigation revamp: that page shows why a routine paused and holds the switch), not `work`.
- Not covered by a host test: free text from the linked account with no open card at all while an absence is running. The notice that an absence raises is itself an open card, so the test sends words with that one card open; the "touch on every update, whatever it says" rule is covered by `channels.test.ts`.
