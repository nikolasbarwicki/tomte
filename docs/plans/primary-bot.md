# Spec: a primary bot that coordinates the others

Status: ready. Three grilling rounds settled on 2026-11-17 (see Open questions). The UI calls the role "Chief of Staff"; code and this spec say "primary". Roadmap row "A primary bot that coordinates the others" and "After the gate" item 2 in `grok-bot-replacement-roadmap.md`. Related: [ADR-0002](../adr/0002-bot-handoffs-are-async-a2a-tasks-on-a-host-endpoint.md) (handoffs), [ADR-0009](../adr/0009-unattended-runs-park-on-durable-human-waits.md) (parking), [ADR-0010](../adr/0010-channels-deliver-needs-you-items.md) (channels), [ADR-0011](../adr/0011-double-loop-chat-mode.md) (double-loop), `docs/roadmap.md` items 3 and 6b.

## Problem

I have five bots, one per routine. To ask anything I first pick the right bot, and from my phone I cannot ask at all: a plain Telegram message with no open card gets no reply and reaches no bot (`channels/cards/router.ts`, `words`). Nobody answers "what happened overnight?" across bots, and setting up a new bot or a routine for a bot means opening the web UI.

Grok Bot solves this with a primary bot: "your main point of contact. It checks in with you on its own and coordinates work with your other Bots" (docs.x.ai/grok-bot/bots). It is a role on an ordinary bot, not a kind of bot, and new work starts there. Rerun, Rakazo, Turnstone and MausBot sell the same idea as a "Chief of Staff" template (`docs/research/grok-bot-alternatives/`).

## What exists

| Piece                                                                                                                                                                 | Where                                        | Gap for a primary                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Handoffs: `list_bots`, `hand_off`, `complete_handoff`, `fail_handoff`, `cancel_handoff`, `handoff_message`, `list_handoffs`; depth 3, 5 open per requester, no cycles | `handoffs/`, `/mcp/bots`                     | `list_bots` gives only name, purpose and idle/working. No roles: any bot hands to any bot              |
| Results arrive through `deliver()` into the requester's main session, or as a synthetic push into a double-loop front                                                 | `host-server/chats.ts`                       | A routine run that hands off ends before the result arrives; the result lands in the chat, not the run |
| Routine tools `create_routine`, `list_routines`, `update_routine`                                                                                                     | `/mcp/routines`                              | Self-only by design ("You can see and change only your own routines")                                  |
| Bot creation `POST /api/bots/new` (name, purpose, avatar)                                                                                                             | `api/bots.ts`, `bots/index.ts`               | No tool creates a bot                                                                                  |
| Host tools (`host`, `bots`, `routines`, `browser`) are always allowed by `createCanUseTool`                                                                           | `bots/session-kit.ts`                        | No approval path for a host tool                                                                       |
| Integrations are host-wide (`integrations.session()` takes no bot); vault grants and the browser are per bot                                                          | `integrations/index.ts`, `credential_grants` | A created bot gets the same integrations every bot has, and no grant                                   |
| Needs-you is per bot (`BotSummary.needsYou`); bots are listed most recently active first                                                                              | `contract/events.ts`, `bots/index.ts`        | No default bot, no place where the app opens                                                           |
| Telegram cards, notices and routine results                                                                                                                           | `channels/`                                  | No conversation: a channel never carries a chat message to or from a bot                               |

## Approaches

### A. Chief of Staff template (the roadmap's current plan)

A normal bot with a seeded purpose and memory, plus `create_bot`. Nothing else changes.

- Pros:
  - Smallest change: one tool and one template.
  - No new host concept.
- Cons:
  - Not a front door. My phone still cannot talk to any bot, and the app still opens on the most recent bot.
  - "What's new across my bots" needs a handoff per bot, five turns and five results arriving out of order, and it cannot work inside a routine run.
  - Every bot can still call `create_bot` unless the template is special anyway.

### B. Primary is a role, and the front door (recommended)

One host-wide pointer names the primary bot. Being primary changes four things: where unaddressed messages go (Telegram plain text, the app's start page), what the bot sees (a team report tool), what it may do (`create_bot`, behind an approval) and its prompt (a "Your team" section). Delegation stays the existing handoffs.

- Pros:
  - The phone becomes a chat with my assistant, which is the Grok Bot feature I actually miss.
  - Reuses handoffs, parking, cards and the double-loop front; the new code is a pointer, one read tool, one write tool and a channel route.
  - Matches Grok Bot's model (a role, replaceable), so a Grok Bot importer (Stage 2) maps onto it.
- Cons:
  - A new host concept that the UI, channels and prompts must all honour.
  - The primary reads other bots' run outputs, which carry web text: a new prompt-injection path into the one bot that can create bots (mitigations under Risks).

### C. Primary as an orchestrator whose background agents are bots

Extend the double-loop front so its tasks are bots instead of `researcher` and `worker`: "start a task on Job scout" opens a handoff, the Tasks tab shows handoffs, a handoff result is a report. Each handoff runs in its own session on the assignee, headless and parkable, like a double-loop routine run.

- Pros:
  - The best experience: parallel, steerable, cancellable delegation in one chat, with reports instead of handoff cards.
  - Assignee chats stay clean, since handoff turns no longer land in their main session.
- Cons:
  - Two task systems (`loop_tasks` and `handoffs`) merged or bridged; ADR-0002's "handoff turns run in the assignee's main session" and ADR-0011's agent model both change.
  - A bot cannot be an SDK subagent of another bot's session without losing its own browser, vault grants and isolation, so a "bot task" is a handoff dressed as a task, with a translation layer to keep consistent.
  - Roughly three times B's work before the first useful result.

### D. A host router, no primary persona

The host classifies each unaddressed message (a small model call) and forwards it to the best-fitting bot, like agentes.chat's router and MausBot's auto-routing.

- Pros:
  - No extra bot context or turn per message.
  - No bot gains new powers.
- Cons:
  - Nobody synthesises across bots, so "what's new?" has no answerer.
  - A misroute is silent, and the router is a second model call the host owns, outside every harness.
  - Bot creation and setup still need the web UI.

### E. Group chat or a shared task board

Grok Bot's group chats (2 to 6 bots, "let the participating Bots decide who should respond") or the board ADR-0002 deferred.

- Pros:
  - Familiar from team chat products.
- Cons:
  - Built for teams; for one person it multiplies turns and cost.
  - ADR-0002 already rejected the board because Tomte's bots have distinct purposes.

### Comparison

| Approach                  | Phone front door | "What's new" across bots    | Creates bots | New concepts                    | Size   |
| ------------------------- | ---------------- | --------------------------- | ------------ | ------------------------------- | ------ |
| A. Template               | No               | Slow, chat only             | Yes          | None                            | Small  |
| B. Role and front door    | Yes              | One tool call, also in runs | Yes, asks    | Primary pointer                 | Medium |
| C. Orchestrator over bots | Yes              | Yes                         | Yes          | Bot tasks, own-session handoffs | Large  |
| D. Host router            | Partly           | No                          | No           | Router                          | Medium |
| E. Group chat or board    | No               | Partly                      | No           | Groups or board                 | Large  |

## Recommendation

Build B now. Keep C as the later upgrade if handoff cards in the primary's chat prove clumsy; B's pieces (pointer, team report, `create_bot`, channel route) all survive into C.

The calls inside B:

1. **Optional, never in the way.** No primary exists until I pick one, and every bot stays usable directly in the web UI, the desktop app and its own chat, whether a primary is set or not. Being the primary adds powers to one bot; being a non-primary bot changes nothing. Handoffs stay any bot to any bot. The primary is for "I am not sure which bot" and "what happened across my bots", not a gate in front of them.
2. **The primary is a pointer, not a flag on bots.** One row, so two primaries cannot exist.
3. **My phone talks to the primary.** With a primary set, a plain Telegram message goes to it. Cards are answered with their buttons or by replying to the card. This replaces today's "one open card takes a plain message" rule only while a primary is set.
4. **No cross-bot write tools.** The primary changes another bot only by handing it a task ("add a weekly routine that checks X"); that bot uses its own self-only routine and memory tools. `create_bot` is the one exception, because a bot that does not exist cannot be asked.
5. **`create_bot` always asks.** A fixed approval, never "always allow", refused in unattended runs.
6. **No Autopilot.** The primary never answers another bot's approval. Roadmap Decision 3 rejected a model judging what is safe; a coordinator answering cards is the same thing.
7. **A team report instead of fan-out.** "What's new" reads host data (runs, outputs, open items) in one synchronous call, so it works in a 07:00 routine run, where a handoff's result would arrive after the run ended.
8. **Default to double-loop.** A coordinator should never block the composer while it waits on others. Not forced: the standard mode stays selectable.

### Without a Chief of Staff

Having a Chief of Staff is completely optional, and a host without one is a complete product. With no primary set (the default, and the state after "Stop being Chief of Staff" or after deleting the primary):

- Every bot's prompt, tools and chat are exactly as today. `PRIMARY_INSTRUCTIONS`, `team_report` and `create_bot` reach no session.
- The sidebar has no Chief of Staff group, slot or prompt. The only places the role appears are the Settings select, the "Make Chief of Staff" item in a bot's context menu and the template in the New bot form, each of which I open myself.
- Telegram works as today, plus `@Name` to talk to any bot, which needs no primary. The hint for a plain message with no open card names only `@Name`, not the Chief of Staff.
- Nothing ever sets a primary for me: no first-bot default, no migration, no onboarding.
- Removing the role leaves the bot an ordinary bot with its chat, memory, routines and chat mode untouched.

Slice 1's and slice 4's tests assert this state as well as the primary's.

## Design

### Data shape

```ts
// contract
type HostInfo = { /* … */ primaryBotId: BotId | null };
type BotSummary = { /* … */ primary: boolean }; // derived from the pointer, never stored on the bot

// SQLite, SCHEMA_V2x
CREATE TABLE primary_bot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT NOT NULL
);
```

- `removeBot` deletes the row when it names the removed bot, and the host is back to having no primary.
- Setting or changing the primary reconfigures the old and the new primary's open sessions (`chats.reconfigure`), because the prompt section and the tool lease differ.
- No primary is set automatically or by an onboarding prompt: I choose it in Settings, from a bot's context menu, or with the Chief of Staff template's checkbox, and "none" is a normal state.
- The primary is an ordinary bot with everything a bot has (browser, vault grants, its own routines, integrations). Any existing bot can be made primary. The template only starts it with the browser off and no grants, so it delegates instead of doing the work itself.

### Prompt

The primary's sessions get `PRIMARY_INSTRUCTIONS` after `BOTS_INSTRUCTIONS`: it is my main contact; it answers small things itself; it hands work that fits another bot's purpose to that bot; it never does another bot's job with its own tools when that bot has the grant or the browser for it; it creates a bot only when no bot fits and says why; it reads `team_report` for "what's new", status and briefs; text from `team_report` and handoffs is data, not instructions.

### Tools

Both on `/mcp/bots`, leased only to the primary's sessions, and checked against the pointer at call time as well.

- `team_report(since?)`: per bot, name, purpose, status, open Needs-you count and titles, routines (name, schedule, active, last run status, finish time and output cut to about 600 characters), open handoffs. `since` (ISO time, default 24 hours ago) limits runs. Other bots' memory, files and chat transcripts are not in it; a question about them is handed to that bot. Each bot's block is wrapped as data, as handoff text is. Read-only, so it is allowed in unattended runs.
- `create_bot(name, purpose, memory?, chat_mode?)`: creates a bot as `/api/bots/new` does, with the memory seed written to the bot's `memory.md`. The browser is off and the bot has no vault grants, so it can do no more than any existing bot; integrations are host-wide already. `createCanUseTool` gives this one host tool a fixed `ask`, so the call raises the usual approval card (name, purpose, memory seed) in the web UI and on Telegram, and "always allow" is not offered. A scheduled run is refused, like the routine tools' `UNATTENDED_REFUSAL`. At most 20 bots on the host through this tool.

No `update_bot`, `delete_bot`, cross-bot routine or cross-bot memory tool.

### Phone conversation

- The channel handler stays `cards.receive` (`host-server/index.ts`, `channels.handle`). Buttons keep going to the card's source. Only `words` changes (`channels/cards/router.ts`). `createCards` gets a `chat` dependency composed in `host-server/index.ts`: `send(botId, text)`, `primary()` (the pointer) and `bots()` (ids and names).
- `words` decides in this order:
  1. A Telegram reply to a card goes to the card's source, as today.
  2. A message that starts with `@` and a bot's full name goes to that bot, with the name stripped. The match is case-insensitive, collapses runs of spaces and needs a space, `:`, `,` or the end after the name; the longest matching name wins, so `@Job scout` beats a bot named `Job`. A leading `@` that matches no bot gets a reply listing the bots' names. This works with or without a primary.
  3. With a primary set, a plain message goes to the primary. It is never taken as a card answer.
  4. With no primary, today's rule: one open card takes it, several ask for a reply. With no open card, one hint line: "To talk to a bot, start with @ and its name, for example @Job scout." (the example is the newest bot's name).
- `chat.send` calls `Chats.send(botId, text, text, [])` with no `eventId`, the same function `/api/send` uses, so queueing and double-loop sends behave as in the web UI. Without an `eventId`, `Chats.send` never takes the ask-first path, so a message routed in steps 2 and 3 cannot answer a card or a pending `ask_user`. A `refused` outcome is sent back as the reply text.
- Replies go back to the phone per bot. Each bot keeps the origin of the owner's latest message to it (`web` or a channel kind) in a `chat_origins` table (bot id, origin, set at), so a restart or a deploy while the laptop is closed does not silence the phone; `removeBot` deletes the bot's row. While the origin is a channel, that bot's messages and double-loop reports are sent with `Channels.send(kind, message)` to that channel's linked account, not as a notice: `noticeMessage` always links the Routines panel and notices are fire-and-forget. The message starts with the bot's name, so two bots replying close together stay apart, and carries a link button to the bot's chat (`/bots/<id>`, none on a loopback http public URL). Replies are sent whole and never edited. A failed send is retried with the notices' backoff, then logged. Writing to that bot in the web UI sets the origin back to `web`. Long replies are cut at Telegram's limit with the same link.

### Web

- Settings, General: "Chief of Staff" select (none, or any bot).
- A bot's context menu in the sidebar gets "Make Chief of Staff", and the primary's gets "Stop being Chief of Staff".
- The sidebar shows the primary in its own group above the "Bots" group, not in the list: one row, a larger avatar, the bot's name with a small "Chief of Staff" caption, and its last message or "Working…" below, on a tinted card (`bg-sidebar-accent/40`, rounded, a border in `border-sidebar-border`). Its Needs-you badge counts its own items only. The "Bots" group lists every other bot exactly as today. With no primary the group is absent; there is no empty state or call to action.
- Nothing else in the web UI changes: the app opens where it opens today, and every bot's chat works as before.
- The bot form gets a "Chief of Staff" template (roadmap 6b's first template): purpose, a memory seed, double-loop on, the browser off, and "Make this my Chief of Staff" checked.

## Slices

Each ends in a check.

1. **Pointer.** Table, `/api/primary` get and set, `HostInfo.primaryBotId`, `BotSummary.primary`, cascade on delete, reconfigure on change, the Settings select, the context-menu items and the sidebar's own group. Check: a host test sets, changes and deletes the primary, and a web test renders the group above "Bots" with the primary left out of the list, and no group without a primary.
2. **Team report.** Tool, lease, prompt section. Check: a fake-CLI test where the primary's routine run calls `team_report` and its output names another bot's last run.
3. **`create_bot`.** Tool, fixed `ask`, unattended refusal, cap. Check: a whole-host test where the approval card appears, approving creates the bot, denying creates nothing, and a non-primary session has no such tool.
4. **Phone conversation.** The `chat` dependency of the card router, `@Name` matching, the `chat_origins` table, replies through `Channels.send`, the changed card rule and the hint. Check: `channels/cards/cards.test.ts` for the routing (reply-to goes to the card; `@Job scout` with bots `Job` and `Job scout`; an unknown `@Name`; plain text to the primary with one and with several cards open; no primary keeps today's rule and gives the hint), and `host-server/telegram.test.ts` cases against the fake Bot API in both chat modes, including replies stopping after a web message and still reaching the phone after a host restart; `smoke:channels-ui` updated.
5. **Template.** The Chief of Staff template and its prompt. Check: `eval:loop-routing` gains team cases (answer itself, hand off to the right bot, read the team report, ask before creating a bot); gate 90%.
6. **My live check.** Laptop closed, from Telegram: "what happened overnight?" answers from the team report; "have the job scout also check X every Friday" hands off and the scout creates its own routine; "make me a bot that tracks invoices" shows an approval card on my phone and creates the bot.

## Risks

- **Injection through the team report.** A scout's run output can carry page text that tells the primary to act. Mitigations: the report is wrapped as data; `create_bot` always asks; handoffs the primary starts run under the assignee's own tool policies, so a write still asks or parks. The `untrusted` flag (roadmap Decision 3) should also mark turns that read a team report, decided with the triggers milestone.
- **Haiku as the router.** A double-loop primary's front is Haiku with thinking off. Routing among bots is unmeasured until slice 5's eval; if it misses, the primary runs standard mode on the bot's model.
- **Handoff turns in assignee chats.** Every delegation adds a turn to the assignee's main session (ADR-0002), and the depth-3 and 5-open limits cap fan-out. Fine for five bots; approach C is the answer if it is not.
- **Changed Telegram rule.** Today one open card takes a plain message. With a primary set, a plain message always goes to the primary, so an answer typed without "reply" becomes a chat message. The primary sees open cards only through `team_report`, never answers them. With no primary, nothing changes.

## Out of scope

Bot-authored skills and the company brain are not part of this feature and the primary does not depend on either (decided in round 1). Also out: Autopilot answers, group chats, bot edit and delete tools, approach C.

## Open questions

Grilled in rounds; answers are recorded here as they settle.

### Round 1 (settled 2026-11-17)

| #   | Question                                                           | Decision                          |
| --- | ------------------------------------------------------------------ | --------------------------------- |
| 1   | Approach B now, C later                                            | Agreed. B must be fully optional  |
| 2   | Ship before the brain                                              | The brain is out of scope for now |
| 3   | Bot-authored skills in this milestone                              | Out of scope for now              |
| 4   | Plain Telegram text goes to the primary; cards by buttons or reply | Agreed                            |
| 5   | No cross-bot write tools; the primary hands off                    | Agreed                            |
| 6   | `create_bot` primary only, fixed ask, refused unattended, cap 20   | Agreed                            |
| 7   | No Autopilot                                                       | Agreed                            |
| 8   | Handoffs keep running in the assignee's main session               | Agreed                            |
| 9   | The primary defaults to double-loop, standard selectable           | Agreed                            |

### Round 2 (settled 2026-11-17)

| #   | Question                                                                                   | Decision |
| --- | ------------------------------------------------------------------------------------------ | -------- |
| 1   | `@Name` from the phone reaches that bot, full-name match, longest wins, primary or not     | Agreed   |
| 2   | A bot's replies go to the phone while my latest message to it came from there, name prefix | Agreed   |
| 3   | No primary: today's card rule, plus a hint when no card is open                            | Agreed   |
| 4   | `team_report` has runs, outputs, Needs-you and handoffs, not memory, files or transcripts  | Agreed   |
| 5   | Chosen in Settings or by the template's checkbox (checked), never automatically            | Agreed   |
| 6   | The primary is an ordinary bot; the template starts it with browser off and no grants      | Agreed   |

Also from round 2: the Chief of Staff sits in its own group above the bot list and looks different from the bots in it.

### Round 3 (settled 2026-11-17)

| #   | Question                                                                               | Decision                                         |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | The UI says "Chief of Staff"; code and docs say `primary`; `GLOSSARY.md` links the two | Agreed                                           |
| 2   | Its badge counts its own items only                                                    | Agreed                                           |
| 3   | No Chief of Staff: nothing for it in the sidebar, no prompt                            | Agreed, and the whole feature must stay optional |
| 4   | "Make Chief of Staff" and "Stop being Chief of Staff" in a bot's context menu          | Agreed                                           |

Nothing is open. "Without a Chief of Staff", under Recommendation, records what optional means.
