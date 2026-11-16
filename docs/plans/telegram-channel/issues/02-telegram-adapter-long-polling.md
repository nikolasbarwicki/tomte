# 02: Telegram adapter with long polling

**What to build:** Telegram is the first adapter of the channel interface. I paste my bot's token on the Channels page, the host checks it and starts long polling, the page shows a `t.me` deep link and the code, and sending the code to the bot links my Telegram account. Everything from other accounts is ignored. See the spec section "Telegram adapter".

New files: `packages/host/src/channels/telegram/` (the adapter and its transport, private to `channels`), a fake Telegram API server in `packages/host/src/testing/` (prior art: `fake-oauth-server.ts`), `eventTokenSecretName`'s sibling in `platform/secrets.ts` for the bot token, a token route in `host-server/api/channels.ts`, and a token field and status on the Channels page from ticket 01.

The adapter splits into a transport (`getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getMe`) and a pure function from a Telegram update to an `Inbound` (and from a `Reply` to calls). A webhook in Stage 3 replaces only the transport.

**Blocked by:** 01

**Status:** done

- [x] The bot token is stored in the secrets backend under its own name in `platform/secrets.ts`, set by `/api/channels/telegram/token` (device-authenticated, body `{token}`), validated with `getMe` before it is stored, and never returned by any route, never in the event stream and never logged. A rejected token is not stored. Deleting the link does not delete the token; a second route call replaces it
- [x] With a token the host starts one long-polling loop (`getUpdates`, `timeout=50`, `allowed_updates` of `message` and `callback_query`) and aborts it on `stop()` and on `close()` of the host. The adapter takes its API base URL as an option (default `https://api.telegram.org`) and the poll timeout as an option, so tests are fast
- [x] Errors back off from 1 s to 30 s. A 401 stops polling and `/api/channels/list` reports "the bot token was rejected" for Telegram; setting a token restarts it. A 409 is reported as "another process polls this bot or a webhook is set". A running loop is reported as running with the bot's username
- [x] Only a private chat is served. Messages in groups or channels, edited messages and updates with no sender are ignored with no reply
- [x] Sending the code (as a plain message or as `/start <code>`) from a private chat links that Telegram user id, and the confirmation arrives in that chat. The Channels page shows the link `https://t.me/<username>?start=<code>` next to the code, built from `getMe`. A second account sending a valid code later replaces the link; before that it gets nothing, as a stranger
- [x] A message, a `/start` without a code, a button press or an edited message from any account that is not linked gets no reply: the fake Telegram server records no outgoing call for it, not even `answerCallbackQuery`
- [x] Sent text is plain: no `parse_mode`, link previews off. A message longer than 4096 characters is cut below the limit. A 429 with `retry_after` is waited out and retried, and consecutive sends are spaced, so a burst of messages is all delivered in order
- [x] The update offset advances after an update is handled. A restart re-reads at most the unconfirmed updates, and handling them again does nothing the first time did not (a code is single use)
- [x] `HostServerOptions` accepts the Telegram API base URL and poll timeout, so the whole-host test harness (`testing/test-host.ts`) points the adapter at the fake server
- [x] Tests at the host HTTP seam with the fake Telegram server cover: token set, rejected and replaced; polling starts and stops with the host; link by `/start <code>` and by plain code; a stranger ignored in every update type; 401 and 409 states; a 429 retry; a cut long message; `restart()` re-handling an unconfirmed update. A browser smoke on `scripts/smoke-kit.ts` (listed in `docs/smoke.md`) drives the Channels page: paste a token, see the link and code, link through the fake server, see the linked state, Unlink. `bun run check` passes
