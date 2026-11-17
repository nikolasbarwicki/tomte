# Spec: Chief of Staff as a switch on a regular bot

Status: ready-for-agent

Supersedes `docs/plans/primary-bot.md` (approach B, "the primary is a role, and the front door") and the build on the `feat/primary-bot` branch, which is kept unmerged as a reference. Owner feedback on that build (2026-11-17): it was too complex and added too much UI. The Chief of Staff should be a regular bot that has an extra prompt section and knows it supervises the other bots. Every bot should be able to list, hand off to and create bots. The design returns to approach A of the design doc (a template-like bot plus `create_bot`) and adds one switch. Respect ADR-0002 (handoffs), ADR-0009 (parking), ADR-0010 (channels) and ADR-0011 (double-loop); none of them changes.

## Problem Statement

I run several bots and want one of them to supervise the rest: take my goals, split them up, hand the parts to the right bot, keep a log and brief me. Today any bot can hand off, but none is told to act as my coordinator, and no bot can create another bot, so growing the team means opening the web UI. From my phone I can answer cards, but I cannot talk to a bot at all.

The previous design made the coordinator a host-wide role with its own table, routes, Settings select, context menu items, sidebar group, template picker, gated tools and Telegram routing. That is too much machinery for what is mostly a prompt.

## Solution

- **Chief of Staff is a switch on a bot.** Turning it on adds a fixed prompt section to that bot's sessions. Nothing else about the bot changes: same tools, chat mode, model, memory, routines, place in the list. At most one bot has it on; turning it on for one turns it off on the previous one.
- **Every bot can create bots.** `create_bot` joins the bots tools every bot already has (`list_bots`, `hand_off`, and so on). Every call raises an approval card; there is no "always allow".
- **The sidebar is the same list for every bot.** The Chief of Staff's row carries a small "Chief of Staff" badge.
- **The phone talks to any bot with `@Name`.** It is independent of the switch. A plain message has no implicit target; with no open card it gets a hint about `@Name`. The bot's replies come back to the phone while the owner's latest message to it came from there.

## User Stories

1. As the owner, I want to switch any bot to Chief of Staff on its Profile page, so that the role is one setting on a bot I already know.
2. As the owner, I want a "Chief of Staff" checkbox in the New bot form, so that I can create one in a single step.
3. As the owner, I want turning the switch on for one bot to turn it off on the previous one, saying so in the form, so that one bot is clearly in charge.
4. As the owner, I want turning it off to change only the prompt, so that the bot keeps its chat, memory, routines and mode.
5. As the owner, I want the Chief of Staff in the same sidebar list as every bot, with a small badge, so that the list stays one list.
6. As the owner, I want the Chief of Staff to decide for each goal whether it finishes it, delegates it or parks it for my approval, so that I hand over goals, not steps.
7. As the owner, I want every delegated task to have a named owner, a one-sentence deliverable and a stop rule, so that I can see who does what.
8. As the owner, I want the Chief of Staff to keep a dated log of its decisions and skipped actions in its files folder, so that I can audit it.
9. As the owner, I want every report to end with what is finished, what waits on me and what was killed and why, so that I can scan reports quickly.
10. As the owner, I want the Chief of Staff to ask me before anything external, financial, public, destructive, contractual, account-changing or irreversible, so that consequential actions stay my decision.
11. As the owner, I want any bot to propose a new bot when none fits, so that I can grow the team from a conversation with any bot.
12. As the owner, I want every bot creation to raise an approval card showing name, purpose and memory seed, with no "always allow", in the web UI and on my phone, so that no bot joins my roster without my say.
13. As the owner, I want a scheduled run that tries to create a bot to be refused, so that nothing is created while I am away.
14. As the owner, I want a created bot to start with the browser off, so that a new bot can do no more than the bots I set up myself.
15. As the owner, I want creation refused once the host has 20 bots, so that a looping conversation cannot flood my roster.
16. As the owner, I want to start a Telegram message with `@` and a bot's name to send it to that bot, so that I can talk to any bot from my phone.
17. As the owner, I want `@` names matched without regard to case or extra spaces, with the longest name winning, so that `@Job scout` reaches "Job scout" even when "Job" exists.
18. As the owner, I want an `@` that matches no bot to get a reply listing my bots, so that I can fix a typo.
19. As the owner, I want a plain message with no open card to get a hint about `@Name`, so that I am not met with silence.
20. As the owner, I want a bot's replies to come back to Telegram, named and with a link to its chat, while I last wrote to it from Telegram, and to stop when I write to it on the web, so that the conversation follows me.
21. As the owner, I want a message to a busy bot to queue as on the web, and a refused one to say why, so that phone and web behave the same.
22. As the maintainer, I want the switch stored in `bot.json` beside the bot's other settings, so that there is no extra table, route or pointer.
23. As the maintainer, I want every bot to have the same tools, so that tool availability never depends on a role.

## Implementation Decisions

### The switch

- `Bot.chiefOfStaff: boolean` in the contract (`events.ts`), so `BotSummary` carries it. `StoredBot` defaults it to `false` for older `bot.json` files. `save()` keeps the stored value like the other settings, so a stale in-memory copy never overwrites it.
- One host function in `bots/index.ts`, `setChiefOfStaff(dataRoot, id, on)`, writes the flag. Turning it on clears it on every other bot. It returns the ids whose flag changed. Callers reconfigure those bots' open sessions with `chats.reconfigure(id, "chief of staff changed")`, as a profile change does: a busy chat reopens after its turn and a double-loop front reopens when idle. No new session, no change of chat mode.
- No new route. `BotProfileUpdate` gains `chiefOfStaff: boolean`, and `/api/bots/profile` applies it with the profile. `/api/bots/new` takes an optional `chiefOfStaff` (default false). A deleted bot takes its flag with it, so the delete cascade does nothing extra.
- If an older host or a hand edit leaves the flag on more than one bot, the bots list shows every flagged bot as stored. The next save that turns it on for a bot clears it on the others.

### Prompt

- `botIdentity` (`bots/index.ts`) appends `CHIEF_OF_STAFF_INSTRUCTIONS` when the bot's flag is on. That is the one place the standard thread, the double-loop front, its workers and routine runs read the persona from, and it is computed from `freshBot` when a session opens. A bot with the flag off has exactly today's prompt.
- The section is fixed in code, adapted from the owner's reference prompt to Tomte's tools. The owner tailors the role through the bot's purpose, its memory and the global instructions; the section itself is not editable. Draft:

```
## You are the owner's Chief of Staff
You report to the owner and supervise their other bots. list_bots shows them; hand_off gives one a task.

What you own:
- Every goal the owner sends you: decide whether you finish it yourself, delegate it or park it for their approval.
- Breaking a goal into sub-tasks, each with a named owner (a bot, or you), a source and a review point. Work that fits another bot's purpose goes to that bot; do not do its job with your own tools.
- The owner's briefs and reviews. Schedule them with your own routine tools when asked. A scheduled run cannot wait for a handoff's result, so a brief reports from your log and the results already in this chat.
- chief_log.md in your files folder: every decision you made and every action you skipped, dated.
- Proposing a new bot with create_bot when no existing bot fits, saying why none does.

What good output looks like:
- Every claim has a source and a date. If you cannot cite it, leave it out.
- Every hand_off brief names the owner, the deliverable in one sentence and a stop rule.
- Every report ends with three lines: what is finished, what is waiting on the owner, what you killed and why.
- Never "I think" or "probably". Either you know or you ask.

Where you stop (ask the owner with ask_user, never do it alone):
- Sending anything to a person outside the company.
- Moving, spending or committing money.
- Publishing anything public.
- Deleting anything that is not obvious junk.
- Signing up, agreeing to terms or accepting any contract.
- Changing account settings, billing or connected integrations.
- Any action you cannot undo in under one minute.
Another bot's approvals, questions and takeovers are the owner's to answer: say what waits and which bot it belongs to.

Style: short, structured, no filler. Say who is doing what.
```

### `create_bot` for every bot

Port from `feat/primary-bot` (`b666cd8`, `e3110e7`), without the role gate:

- `createBot(dataRoot, name, purpose, id, avatar, memory)` writes an optional memory seed to the new bot's memory file; blank writes nothing. The HTTP route does not take a memory field; no UI needs it.
- `create_bot(name, purpose, memory?, chat_mode?)` on the bots MCP server, registered for every bot. `BotsToolContext` gains `unattended()` and `createBot(spec)`. Guards, in order: a scheduled run is refused (the routine tools' kind of text); name at most 80 characters, purpose required and at most 400, memory at most 1200 (this keeps the approval card under the size at which a channel card offers Deny only); refused at 20 bots on the host. The bot starts with the browser off. `chat_mode` defaults to `standard`, the new bot's `chiefOfStaff` is false, and the owner's open chat stays where it is. A bot cannot create a Chief of Staff.
- `ALWAYS_ASK_TOOLS` (`waits/index.ts`) holds `mcp__bots__create_bot`. `createCanUseTool` checks it before `approveAll`, a stored allowance and the `mcp__bots__` allow prefix, so even a host that approves everything raises the normal approval card. `approvalActions` leaves out `allow_always` for it. Where nobody watches (`HostDelegate.attended()` false), it is denied at once with no card and no wait.
- The double-loop front's bots lease is `attended` (`BotsEndpoint.lease(botId, { attended: true })`), like its routines lease.
- `BOTS_INSTRUCTIONS` gains one line for `create_bot`: propose a bot only when none fits, say why, and wait for the owner's approval.
- `PRIMARY_INSTRUCTIONS`, `botsInstructions(primary)`, `isPrimary()` and `team_report` are not ported.

### Sidebar and forms (web)

- Sidebar (`app/app-sidebar.tsx`): one list as today. A bot with `chiefOfStaff` gets a small muted pill, "Chief of Staff", next to its name (`shrink-0`, the name truncates first), with `data-chief-of-staff` for tests. No group, no context menu items, no Settings select.
- Profile page (`features/bots/profile-form.tsx`): a "Chief of Staff" switch saved with the profile. Its description says what the role does and, when another bot holds it, "Turning this on removes it from <name>."
- New bot form (`features/bots/new-bot.tsx`): a "Chief of Staff" checkbox with the same description. No template picker, no memory field, no chat-mode field.

### Phone: `@Name` and replies

Port `f69ce82` (Telegram `@Name`, `chat_origins`, replies to origin) without the primary:

- The card router's injected `CardChat` is `send(botId, text, channel)` and `bots()` (newest first), with no `primary()`. Decision order for words from the linked account: a reply to a card goes to its source; `@Name` goes to that bot (the `leadingMention` rules), with an unknown name answered by the list of names; otherwise one open card takes the message, several ask for a reply, and with none the owner gets "To talk to a bot, start with @ and its name, for example @<newest bot's name>."
- `chat_origins` is the next schema step (`SCHEMA_V29`). `/api/send` sets `web`, and a routed Telegram message sets `telegram`, neither for a refused send. `removeBot` deletes the row.
- `ChatsDeps.botSaid` forwards a standard turn's final text, a double-loop front's reply and each report to `Channels.say` while the origin is a channel. Scheduled run turns are not forwarded.
- Plain-message routing to the Chief of Staff (old ticket 05) is not ported. The origin rule is transport-independent, so a future mobile app, which picks the bot in its own UI, reuses it without an implicit target. Routing plain Telegram messages to the Chief of Staff later is a small router change: one more `CardChat` member read from the flag.

## Testing Decisions

Tests drive the host the way users do and assert what they observe, as in the previous spec. Port tests from `feat/primary-bot` where they apply, removing every primary case.

1. Whole host over HTTP with the fake CLI and the fake Bot API:
   - Switch: on through `/api/bots/new` and `/api/bots/profile`; turning it on moves it from another bot; `BotSummary.chiefOfStaff` follows; an open session is reconfigured and its next turn's system prompt carries the section, which disappears when the switch is turned off; a bot with the flag off has no section.
   - `create_bot` (port `handoffs/create-bot.test.ts`): any bot's call raises the card with the exact arguments and no always-allow; approve creates the bot with the seed and the browser off; deny creates nothing; a scheduled run is refused; a chat-hosted routine turn and a headless run are denied with no wait; the cap holds; argument limits; a double-loop front; the card on the fake Bot API.
   - Phone (port `phone-chat.test.ts` without the "a Chief of Staff" blocks): `@Name` reaching the bot and the reply reaching the phone in both chat modes; replies stopping after a web send; the origin surviving a restart; the hint; the origin row removed with the bot.
2. Unit: the card router's decision order and `@Name` edge cases with the fake channel and a fake chat (`channels/cards/cards.test.ts`); `can-use-tool.test.ts` for the fixed ask; `channels.test.ts` for `say`.
3. Web: no new pure model. The sidebar badge and the forms are covered by `smoke:channels-ui` (below) or a screenshot in the PR.

`smoke:channels-ui` gains one step: an `@Name` message through the fake Bot API, with the reply read there. Coverage floors are raised if the tests lift them, never lowered.

## Out of Scope

- `team_report` and any cross-bot status read beyond `list_bots`.
- Tools that edit or delete bots or change another bot's routines, memory or integrations.
- Templates (roadmap item 6b) and a memory field in the New bot form.
- Routing plain Telegram messages to the Chief of Staff.
- The Chief of Staff routing eval cases. The switch is a plain prompt section on whatever model the owner picks; add cases if live use shows misrouting.
- A dedicated mobile app.

## Further Notes

- Known limit: without `team_report`, a scheduled brief cannot read what other bots' routines did overnight. It reports from the Chief of Staff's own log and the handoff results already in its chat. If briefs prove too thin, the smallest fix is a last-run line per bot in `list_bots`, for every bot, rather than a role-only tool.
- `create_bot` on every bot widens who can propose a bot. The guards are the fixed approval card, the unattended refusal and the cap; a bot created this way can do no more than the bots the owner created.
- `GLOSSARY.md`'s "Primary bot" entry becomes "Chief of Staff": a bot with the Chief of Staff switch on, at most one per host, a prompt section and nothing else.
