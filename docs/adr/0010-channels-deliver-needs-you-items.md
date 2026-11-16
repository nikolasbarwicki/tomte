# 0010: Channels deliver needs-you items and route answers back

Status: accepted. Builds on [ADR-0008](0008-answer-relay-hook.md) and `docs/plans/answer-path-and-relay.md`: a channel answers through the same answer path as the web UI. Needs [ADR-0009](0009-unattended-runs-park-on-durable-human-waits.md): a parked run waits for an answer that a channel can bring.

## Context

A parked run waits for the owner, and the owner is often away from the web UI. A routine that asks at 03:00 is useful only if the owner learns of it on a phone and can answer there. Nothing reaches a phone today.

Options for the phone are a Telegram bot, Web Push to the installed web UI, a Slack app and a native app. Telegram is free, its buttons edit a message in place, voice notes are built in, and its webhook can wake a sleeping machine in Stage 3. Web Push on iOS works only after "Add to Home Screen" and Apple revokes a subscription when a push shows no notification. Slack needs a workspace and is too much for one person. A native app is months of work. Whichever comes first, it must not be wired into the host: WhatsApp, Slack and Web Push are likely later.

## Decision

Claudebot has a channel interface, and Telegram is its first adapter.

- **The interface does three things.** A channel delivers a needs-you item (an open external event or an open human wait), delivers a routine result, and routes an answer back through the answer path of ADR-0008 and `docs/plans/answer-path-and-relay.md`. The host decides where an answer goes and closes the item, exactly as for an answer from the web UI. A channel never writes to a run or a session itself.
- **A channel link, made with a one-time code.** The web UI shows a one-time code. The owner sends it to the channel's bot, and the host stores the owner's account id on that channel. Only one user is linked per channel. An update from anyone else is ignored: it gets no answer, and it reaches no code that does work. The code is single-use. Each customer in Stage 3 has their own host, so the same linking serves them.
- **The bot token lives in the secrets backend.** Like the event token of ADR-0007, it is never in the database, the event stream or a log.
- **Handling an update does not depend on the transport.** Telegram updates arrive by long polling now, because the VPS is always on. A webhook comes in Stage 3, when machines sleep and a message must wake one. Both feed the same function, which takes one update and returns what to send.
- **Free text answers an open card only.** Without an open card a message does nothing. Buttons and text on a card go through the answer path, so a stale, answered or already-handled card is refused like a stale chip in the web UI.
- **A channel never edits what an approval covers.** The card shows the exact input the approval covers (ADR-0009). Long input is cut short with a link to the web UI. To change it, the owner denies with a note or edits in the web UI.
- **What it sends.** Every needs-you item, an expired park, a failed run and an auto-pause. For a routine that opts in, a short result with a link. Every card has buttons and a link to the web UI.
- **Takeover on a phone.** A takeover card opens the live view in the phone's browser over Tailscale. If touch input does not work there, the takeover waits for the laptop within the 24-hour park, and a mobile live view becomes its own task.
- **Order of adapters.** Telegram first. Web Push in Stage 2. WhatsApp and Slack later, each an adapter behind the same interface, with no change to the host's answer path.

## Alternatives considered

- **Web Push to the installed web UI.** No third party. Deferred to Stage 2: on iOS it needs an installed app and its subscription can be revoked.
- **A Slack app.** Where teams already work. Deferred: it needs a workspace and is too much for one person.
- **A native iOS app.** The best experience. Rejected for now: months of work and App Store review.
- **Telegram wired straight into the host.** Rejected: the second adapter would then be a second copy of the answer logic. One interface means one answer path.
- **Trust any chat that knows the bot.** Rejected: a bot's username is public. The link by one-time code is the only thing that ties a chat to the owner.
- **Let the owner edit the approved input from Telegram.** Rejected: an approval covers the input on the card, and an edit would approve something the owner did not see.

## Consequences

- The host holds a long-polling loop for Telegram while it runs. It makes no inbound connection, so it needs no public address in Stage 1.
- A channel is a second place that can answer a card. The answer path already refuses a second answer, so a double answer from the phone and the web UI is refused once, not run twice.
- Anyone who gets the bot token can send as the bot, and anyone who gets the owner's Telegram account can answer. The token's storage is the secrets backend's; the account is the owner's to protect. The link can be removed from the web UI.
- Voice notes wait until a routine needs them.
- A channel that is down does not stop a run. The wait is a row in `human_waits` and shows in the web UI, and it expires after 24 hours as any park does.
