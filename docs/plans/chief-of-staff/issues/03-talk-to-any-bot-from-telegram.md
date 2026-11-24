# 03: Talk to any bot from Telegram with `@Name`

**What to build:** From Telegram I can start a message with `@` and a bot's name to send the rest to that bot, and its replies come back to my phone until I write to it on the web. With no open card, a plain message gets a hint about `@Name`. Spec `../spec.md`, "Phone: `@Name` and replies". Port `f69ce82` and `e7c8f59` from `feat/primary-bot` without `primary()`.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `CardChat` (`channels/cards/types.ts`) is `send(botId, text, channel)` and `bots()` (newest first), composed in `host-server/phone-chat.ts`; `channels` still imports no feature.
- [x] Decision order: reply to a card goes to its source; `@Name` (`cards/mention.ts`, `leadingMention`: case-insensitive, spaces collapsed, then a space, `:`, `,` or the end, longest name wins) goes to that bot with the name stripped, a bare name is asked for a message, an unknown name gets the list of names; otherwise one open card takes it, several ask for a reply, none gets the hint.
- [x] `chat.send` goes through `Chats.send(botId, text, text, [])` with no item id: queues on a busy bot, reaches a background-tasks front as a send, never answers a pending question or approval; `queued` and `refused` outcomes are replied as text.
- [x] `chat_origins` (`SCHEMA_V29`, `bots/origin-store.ts`): `/api/send` sets `web`, a routed Telegram message sets `telegram`, neither for a refused send; `removeBot` deletes the row; it survives a restart.
- [x] `ChatsDeps.botSaid` plus `Channels.say`: while the origin is a channel, a standard turn's final text, a background-tasks reply and each report go to the linked account, prefixed with the bot's name and with a link button (none on a loopback http public URL), whole, never edited, retried with the notices' backoff. Scheduled run turns are not forwarded.
- [x] Tests (port, removing the "a Chief of Staff" and "with a primary bot" blocks): router order and `@Name` edge cases in `channels/cards/cards.test.ts`; `say` in `channels/channels.test.ts`; whole host in both chat modes in `host-server/phone-chat.test.ts`; the origin row in `host-server/bot-delete.test.ts`.
- [x] `smoke:channels-ui` sends one `@Name` message through the fake Bot API and reads the reply there; `docs/smoke.md` says so.
- [x] `AGENTS.md`, "Channels", describes `@Name`, the origin and replies.
- [x] `bun run check` and `bun run smoke:channels-ui` pass.
