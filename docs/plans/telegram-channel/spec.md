# Spec: a channel for my phone, with Telegram as the first adapter

Status: ready-for-agent

Gate step 3 of `docs/plans/grok-bot-replacement-roadmap.md` ("The cancel gate") and its Decision 6 ("Reaching me on my phone"). Decisions are in [ADR-0010](../../adr/0010-channels-deliver-needs-you-items.md); it builds on [ADR-0008](../../adr/0008-answer-relay-hook.md) and `docs/plans/answer-path-and-relay.md`, and needs [ADR-0009](../../adr/0009-unattended-runs-park-on-durable-human-waits.md).

Depends on `docs/plans/unattended-parking/` (done, on master) for human waits (tickets 04 and later here need `issues/01-durable-human-waits.md` and `issues/02-parked-runs.md`). Tickets 01 to 03 depend on nothing open. Related roadmap item: 5 (one chat channel; the remote access and service wrapper parts are done by the VPS install, which gate step 2 covers, so no ticket here). Voice notes are out of scope. Feature 13 (cost guards) builds on it: see "Further Notes".

## Problem Statement

My routines run at night, on the VPS, with the laptop closed. A parked run waits for me ([ADR-0009](../../adr/0009-unattended-runs-park-on-durable-human-waits.md)): an email the Outreach researcher wants to send, a login that expired, a question. Nothing reaches my phone today. The only places that show a wait are the web UI and the desktop banner, and both need me at a screen. A park expires after 24 hours, so a wait I never see ends the run for nothing. When a routine fails, pauses itself or finishes, I learn it only when I open the Routines panel.

I want the VPS to tell me on my phone, let me answer there with one tap, and stay quiet about everything else. I cannot cancel Grok Bot until this works.

## Solution

The host gets a **channel** interface. A channel delivers needs-you items and routine results to me outside the web UI, and routes my answers back through the same answer path the web UI uses. **Telegram** is the first adapter, over long polling. Nothing in the host's answer path knows Telegram exists.

- **Linking.** The Channels page shows a one-time code and a `t.me` deep link. I send the code to my Telegram bot, and the host stores my Telegram user id as the **channel link**. One user per channel. Updates from anyone else are ignored.
- **Needs-you cards.** Every open needs-you item (an external event) and every open human wait (a tool approval, an `ask_user` question, a takeover, a login approval) arrives as one message with buttons and a link to the web UI. Pressing a button answers through the answer path. When the item closes anywhere (web UI, desktop, another channel, expiry), the message is edited in place to say so and its buttons go away.
- **Free text answers an open card.** A reply to a card answers that card. A plain message answers the one open card when exactly one is open. With no open card, or with several and no reply, it answers nothing.
- **Approvals.** The card shows the exact input the approval covers. Long input is cut short with a link to the web UI, and a cut approval is not offered an Approve button. Telegram never edits what an approval covers: I deny, with the reply text as the note, or I edit in the web UI.
- **Run notices.** An expired park and a failed run are sent without any setting. An auto-pause arrives as a needs-you item of kind `notice` from feature 13, through the same cards, with Dismiss only.
- **Routine results.** A routine that opts in sends a short result with a link when it finishes.
- **Takeover.** A takeover card opens the live view in the phone's browser over Tailscale. Whether touch input works there is a manual check; if it does not, the takeover waits for the laptop within the 24-hour park, and a mobile live view becomes its own task.

## User Stories

1. As the owner, I want the Channels page to show a one-time code and a Telegram link, so that I can connect my phone in a minute.
2. As the owner, I want the code to work once and expire in 10 minutes, so that a code I forgot about is not a way in.
3. As the owner, I want the host to ignore every Telegram account except the linked one, so that anyone who finds my bot's username gets nothing.
4. As the owner, I want a stranger's message to get no reply at all, so that the bot does not confirm it is mine.
5. As the owner, I want the bot token kept in the secrets backend and never shown again, so that it does not leak through the UI, the event stream or a log.
6. As the owner, I want to unlink Telegram from the Channels page, so that I can move to another account at once.
7. As the owner, I want the Channels page to say whether Telegram is running and why not when it is not, so that I can fix a wrong token without reading logs.
8. As the owner, I want each open needs-you item to arrive once as a message with buttons, so that I can answer without opening the web UI.
9. As the owner, I want the question's suggested answers as buttons, so that I answer in one tap.
10. As the owner, I want a failed item's Retry and Skip, a done item's Review and a stopped item's Status as buttons, so that the phone offers what the web UI offers.
11. As the owner, I want every card to carry a link to the web UI at the right panel, so that I can see more when a button is not enough.
12. As the owner, I want a card that is answered on another device to change to "handled" in Telegram, so that I never press a stale button.
13. As the owner, I want a button on a card that was already handled to be refused with a short note, so that a double answer from the phone and the web UI runs once.
14. As the owner, I want to answer a question with free text by replying to its card, so that I can say something the buttons do not.
15. As the owner, I want a plain message to answer the only open card, so that I need not use Telegram's reply gesture when one thing waits.
16. As the owner, I want a plain message to answer nothing when several cards are open, so that a message never lands on the wrong card.
17. As the owner, I want a message with no open card to do nothing to any run, session or chat, so that a stray message cannot start work.
18. As the owner, I want a tool approval's card to show the exact input it covers, so that I know what I approve.
19. As the owner, I want long input cut with a link, and no Approve button on a cut card, so that I never approve input I could not read.
20. As the owner, I want a reply to an approval card to deny it with my text as the note, so that I can say what to change without editing the input.
21. As the owner, I want an `ask_user` question from a routine as a card with its options as buttons, so that a parked run resumes when I answer.
22. As the owner, I want a takeover card with a link that opens the live view in my phone's browser, so that I can finish a login from the phone.
23. As the owner, I want a message when a park expires and the run fails, so that I know what to redo.
24. As the owner, I want a message when a routine run fails, so that a night-time failure does not wait for me to look.
25. As the owner, I want a card when a routine pauses itself after repeated failures or after my absence (feature 13's `notice` item), so that I know why it stopped running.
26. As the owner, I want to switch result messages on per routine, so that a daily brief reaches my phone and a quiet housekeeping routine does not.
27. As the owner, I want a result message to be short and to link to the run, so that the phone shows the gist and the web UI shows the rest.
28. As the owner, I want a card to be sent once, also across a host restart, so that a deploy does not resend what I already answered or ignored.
29. As the owner, I want cards that arrived while Telegram or the host was down to be sent when they are back, so that a wait I never saw is not lost.
30. As the owner, I want a Telegram outage to leave runs and the web UI working, so that a channel is a convenience and not a dependency.
31. As the owner, I want anything I do in Telegram to count as activity for the absence pause, so that a week of answering from the phone does not pause my routines.
32. As the owner, I want text from outside (an event body, a tool input) shown as plain text, so that it cannot format or link a card into something it is not.
33. As a contributor, I want the update handler to take one update and return what to send, so that a webhook in Stage 3 reuses it unchanged.
34. As a contributor, I want a second adapter to need no change in the host's answer path, so that WhatsApp, Slack or Web Push are adapters and not rewrites.

## Implementation Decisions

### Vocabulary

GLOSSARY already defines **Channel**, **Channel link**, **Human wait**, **Parked run** and **needs-you item**. This feature adds no new term. A channel delivers a needs-you item (an open external event) or a human wait; this spec says "item" for either when the difference does not matter. A **card** is the message a channel sends for one item.

### The channel interface (new feature module `channels`, ADR-0003 shape)

`packages/host/src/channels/` with an `index.ts` interface. It imports no other feature; the composition root (`host-server/index.ts`) passes it collaborators as arguments typed by interfaces.

```ts
// shape; names may change in review, the three duties may not
interface Channel {
  readonly kind: string; // "telegram"
  start(): void; // begin receiving; a transport detail
  stop(): Promise<void>;
  send(to: Account, message: ChannelMessage): Promise<MessageRef>;
  edit(ref: MessageRef, message: ChannelMessage): Promise<void>;
}
type ChannelMessage = {
  text: string;
  buttons?: { label: string; data: string }[][];
  link?: { label: string; url: string };
};
type Inbound = {
  from: Account;
  text?: string;
  button?: { data: string; on: MessageRef };
  replyTo?: MessageRef;
};
type Reply = {
  toast?: string;
  send?: ChannelMessage[];
  edit?: { ref: MessageRef; message: ChannelMessage }[];
};
// Channels.receive(kind, inbound): Promise<Reply>  — the one transport-independent handler
```

- **Delivery** goes one way: the host calls `send` and `edit`. **Routing back** is `Channels.receive`: one inbound update in, a `Reply` out, with no knowledge of the transport. Long polling and, later, a webhook both call it.
- `Channels.receive` links, or ignores, or hands a linked account's update to the answer path. It never writes to a run or a session itself (ADR-0010).
- A `button.data` is opaque to the adapter, at most 64 bytes (Telegram's limit for `callback_data`), and never carries an answer's text: it carries an id and an option index, and the host reads the text from what it stored.

### The channel link

- Table `channel_links`: `channel` (primary key, so one account per channel), `account_id`, `label` (the account's display name, for the page), `linked_at`. Table `channel_link_codes`: `channel`, `code_digest`, `expires_at`, `used_at`, plus a failure count. Only a digest of a code is stored.
- A code is 12 base32 characters in groups of four, single use, valid 10 minutes; 10 failed attempts invalidate every outstanding code. This is the pairing code's format and rules (`device-auth/index.ts`: `createPairingCode`, `pair`, `MAX_FAILURES`), implemented again for channels. Extracting shared helpers is fine when the Devices tests still pass.
- An inbound update is judged in this order: from the linked account, it goes to the answer path; from anyone else, if its text has the shape of a code (after `/start `, case, separators and spaces are stripped), it counts as an attempt and links the account when the code is valid; anything else is ignored with no reply and no failure count, so a stranger cannot burn my codes by sending noise.
- A successful link replaces any earlier link for that channel and gets a short confirmation reply. Unlinking deletes the row. The host never learns the owner's phone number or chat from anywhere but this exchange.
- Every update from the linked account calls an `onActivity` collaborator, so feature 13's absence pause counts it.

### Telegram adapter

- The bot token is a secret named in `platform/secrets.ts` beside `eventTokenSecretName` (for example `channel-token:telegram`), set from the Channels page through a device-authenticated route, checked with `getMe`, never returned and never logged. A host in remote mode with file secrets keeps it in `secrets.enc` like the event tokens.
- `getUpdates` long polling, `timeout=50`, `allowed_updates` of `message` and `callback_query` only, one loop per running channel, aborted on `stop()`. Errors back off (1 s doubling to 30 s). A 401 from Telegram marks the channel as failed with "the bot token was rejected" and stops until the token is set again. A 409 (another poller or a webhook holds the bot) is shown as such.
- Only a private chat with the linked account is served. Groups, channels and edited messages are ignored.
- The update offset lives in memory. After a restart Telegram redelivers what it has not seen confirmed; handling is idempotent (a code is single use, a closed item refuses a second answer).
- Cards are plain text with no `parse_mode`, so nothing an event or a tool input contains can be formatted. Link previews are off. A message is cut below Telegram's 4096-character limit. The sender honors `retry_after` on a 429 and spaces consecutive sends, so a burst of cards does not drop any.
- The adapter accepts a base URL for the Telegram API, so tests run against a fake server (`testing/`, like `fake-oauth-server.ts`).

### Cards

- Table `channel_cards`: `channel`, `item_kind` (`event` or `wait`), `item_id`, `bot_id`, `message_ref`, `sent_at`, `closed_at`, unique on `(channel, item_kind, item_id)`. A card is sent once per item. At host start and right after linking, every open item with no row is sent, oldest first.
- The host composes a card's buttons in one place. The needs-you buttons (`itemActions` in `packages/web/features/chat/model.ts`) move to `@claudebot/contract` as a pure function, so the web UI and every channel offer the same buttons and messages. A button whose action is only a draft (`Answer…`, `Other…`, `Unblock…`) becomes a hint: "reply to this message".
- A button answers with its item id and an option index. The host looks the option up in the stored item. A stale index, a closed item or an item that belongs to no bot is refused with a short toast.
- When an item closes by any route, the card is edited to its outcome ("Handled", "Dismissed", "Resolved by its source"; for a human wait "Answered: <button label>", "Cancelled", "Expired") and loses its buttons.
- **Link.** Each card has a URL button to the web UI at the public URL, `/bots/<botId>?panel=work` for needs-you items, `?panel=routines` for run notices and results, `?panel=browser` for a takeover, `/bots/<botId>` otherwise. The public URL is the one `HostConfig.publicUrl` carries (`clientAt.publicUrl`); on this VPS that is the `tailscale serve` URL. When the public URL is loopback http, Telegram would reject the button, so the card has no link.
- **Truncation.** A card gives the title and body or input at most about 3000 characters, then "…" and the link. An approval whose input was cut has no Approve button, only Deny and the link, so the approval can only cover input the owner could read.
- **Free text.** A reply to a card answers that card. Otherwise, when exactly one card is open, the message answers it. With several open and no reply it answers nothing and says to reply to the card. With none it answers nothing. On an external event it is the answer, on an `ask_user` question it is the answer, on an approval it denies with the text as the note, and on a takeover card it is refused (use the buttons).

### Answering from a channel

- The web UI's answer path is tied to the open chat: `/api/send` runs on `ctx.chats.open()` (`host-server/api/index.ts`), which exists for the bot the page shows. A channel answers for any bot, so the send logic in `chats.ts` (`openChat(chat).send`: linked ask first, queue when busy, close the item once the message reaches the bot) is reachable by bot id and the web route uses the same function. A channel gets the same four outcomes the web UI gets: `answered`, `sent`, `queued`, `refused`.
- A human wait is answered through the human-waits interface that ticket 01 of feature 10 puts on `human_waits`, which is `HumanWaits.answer` and `Chats.answer` today. `queued` is shown honestly ("queued; the bot is busy"), never as handled.
- A refusal ("that item is already handled") is a toast, not a card edit. The card is edited only when the item really closed.

### Notices and results

- `Channels.notify(notice)` sends one message to the linked account. Notice kinds: `run_failed`, `park_expired` and `routine_result`. Notices have no buttons beyond the link, are not cards, and are not tracked after sending. An auto-pause or an absence pause is not one of them: feature 13 makes it a needs-you item of kind `notice`, which the cards of ticket 03 deliver like any other open item.
- Routines get an `onRunEnded` seam in `createRoutines` (`routines/index.ts`), called when a run reaches a terminal status (`succeeded`, `failed`, `interrupted`; with feature 10, also after a parked run resumes and finishes).
- `Routine` gains `notifyResult: boolean` (a column on `routines`, default off), editable like `catchUp`: contract, `RoutineInput`/`RoutinePatch`, the routine form. A result message carries the routine's name, the run's output cut to about 800 characters (the routine prompt already asks for at most five lines) and the link.
- A failed or interrupted run is always sent, whether or not the routine opted in. A host restart that interrupts a run is a run the owner did not get; nothing fails silently.

### Routes and UI

- `/api/channels/list`, `/api/channels/link-code`, `/api/channels/unlink` and `/api/channels/telegram/token`, device-authenticated, in `host-server/api/channels.ts` and dispatched by prefix like `/api/devices/` (`api()` in `host-server/api/index.ts`).
- A `channels` web feature module (ADR-0004), route `/channels`, a sidebar entry beside Devices (`app-sidebar.tsx`). It copies the Devices page's one-time code dialog (`features/devices/devices.tsx`). It shows the token field, the status, the code and the deep link, and Unlink.

## Testing Decisions

- A good test drives the system from outside: a fake Telegram API server in, Telegram-shaped updates through it, the host's HTTP API and event stream and the bot's received messages out. No test asserts table rows or wording beyond what a person reads.
- **Seam 1: `Channels.receive` with a fake channel**, for the interface, the link and the answer routing. No network.
- **Seam 2: the host HTTP seam** (`startHandoffHost` in `testing/test-host.ts`, `pairDevice`, `watchEvents`, the fake Claude CLI) with a **fake Telegram API server** the adapter is pointed at, for polling, sending, editing and the whole round trip. Prior art: `host-server/needs-you-answers.test.ts` (answers on a held bot), `testing/fake-oauth-server.ts` (a fake provider), `events/answers.test.ts`.
- Cover: a stranger's updates get no reply and change nothing; a code links once and only once; ten wrong code-shaped attempts kill the codes; a card is sent once across `restart()`; a button answers like the web chip, including on a bot that is not open and on a held (busy) bot; a stale button is refused; an item closed in the web UI edits its card; free text with a reply, with one open card, with several and with none; an approval cut for length has no Approve; a parked routine run resumes through a button on the phone; a failed run, an expired park, a pause and an opted-in result each send one message.
- **Browser smoke:** the Channels page code dialog and Unlink, driven against the fake Telegram server, on top of `scripts/smoke-kit.ts` and listed in `docs/smoke.md`. The routine form's opt-in checkbox is covered there too.
- **Manual:** the phone checks (tickets 07 and 08). No automated test can say whether a mobile browser's touch input drives the live view.
- Existing tests broken by moving `itemActions` into the contract are moved with it, not re-pinned.
- Coverage gates (`coverageThreshold`, `scripts/check-coverage.ts`) must not drop.

## Out of Scope

- **Voice notes.** They wait until a routine needs them (Decision 6).
- **A Telegram webhook.** Stage 3, when machines sleep. The update handler is built so that it is a transport change.
- **Group chats, several linked users, Telegram Business or channels.** One owner, one private chat.
- **Editing what an approval covers from Telegram.** Rejected in ADR-0010.
- **Other adapters:** Web Push (Stage 2), WhatsApp, Slack.
- **Installing the host on the VPS and `tailscale serve`.** Gate step 2, done.
- **A mobile live view,** unless ticket 07 finds touch input broken; then it is a separate task.
- **Quiet hours, digests, per-bot channel settings.** Every item is sent when it arrives.
- **Answer relay changes.** An answer from Telegram goes through ADR-0008's relay like any other.

## Further Notes

- **Code versus plan.** The plan says a channel "routes an answer back through the same answer path as the web UI". That path is not reachable for a bot the page does not show: `/api/send` needs `chats.open()`. Ticket 03 makes the send logic addressable by bot id and moves the web route onto it.
- **`itemActions` lives in the web package.** The plan's "same answer path" also means the same buttons. Ticket 03 moves their definition to the contract.
- **Feature 13 builds on this feature.** `.scratch/13-cost-guards/issues/06-notices-on-the-channel.md` needs ticket 01 here. Auto-pause and absence notices are needs-you items of kind `notice` (its ticket 03), so ticket 03 here delivers them as cards with no special case (`itemActions` in the contract gets a `notice` case with Dismiss only when that kind exists). Its absence pause reads `onActivity` from ticket 01: every update from the linked account, including free text with no open card, counts as presence.
- **The deep link needs a paired browser on the phone.** The link opens the web UI, which needs a device token. The phone's browser is paired once from the Devices page, over the tailnet, and the Tailscale app must be connected when a link is opened. Whether Telegram's in-app browser shares cookies with the system browser is [INFERENCE]: not checked. Ticket 07 and 08 record what they find.
- **Telegram sees the card text.** Everything on a card, including an approval's exact input and a routine's result, passes through Telegram's servers. That is the price of the phone channel and is already in ADR-0010's consequences.
- **Prior art for the link:** the Devices page's pairing dialog (`packages/web/features/devices/devices.tsx`) and `device-auth/index.ts`. Prior art for the answer path: `docs/plans/answer-path-and-relay.md`, `docs/relay.md`, `events/index.ts` (`answer`, `dismiss`), `host-server/chats.ts` (`openChat`, `answerAsk`, `pendingAskFor`).
