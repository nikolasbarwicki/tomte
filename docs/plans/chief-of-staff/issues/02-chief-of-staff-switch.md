# 02: The Chief of Staff switch

**What to build:** A "Chief of Staff" switch on a bot's Profile page and in the New bot form. Turning it on adds `CHIEF_OF_STAFF_INSTRUCTIONS` to that bot's prompt and shows a small badge on its sidebar row, and at most one bot holds it. Spec `../spec.md`, "The switch", "Prompt" and "Sidebar and forms".

**Blocked by:** None (can start immediately; the prompt names `create_bot`, which ticket 01 adds, so merge 01 first)

**Status:** done

- [x] `Bot.chiefOfStaff: boolean` in the contract; `StoredBot` defaults it to false; `save()` keeps the stored value.
- [x] `setChiefOfStaff(dataRoot, id, on)` in `bots/index.ts`: turning it on clears every other bot's flag; it returns the changed ids, and the caller reconfigures each one's open session and announces the bots.
- [x] `BotProfileUpdate` carries `chiefOfStaff`, applied by `/api/bots/profile`; `/api/bots/new` takes an optional `chiefOfStaff`. No other route.
- [x] `botIdentity` appends `CHIEF_OF_STAFF_INSTRUCTIONS` (the spec's draft) when the flag is on, so the thread, the background-tasks front, its workers and routine runs all get it; with the flag off the prompt is unchanged.
- [x] Sidebar: a muted "Chief of Staff" pill beside the name of the flagged bot (`data-chief-of-staff`), the name truncating first; one list, nothing else changes.
- [x] Profile page: the switch, saved with the profile, with a description of the role and "Turning this on removes it from <name>." when another bot holds it.
- [x] New bot form: a "Chief of Staff" checkbox with the same description.
- [x] Whole-host tests: on through both routes; moving it from another bot; `BotSummary.chiefOfStaff` follows; the next turn's system prompt carries the section after switching on and loses it after switching off; a bot that never had it has today's prompt.
- [x] `GLOSSARY.md`: replace "Primary bot" with "Chief of Staff". `AGENTS.md` gets a short "Chief of Staff" section. `docs/roadmap.md` and `docs/plans/grok-bot-replacement-roadmap.md` rows say the Chief of Staff is a switch.
- [x] `bun run check` passes; a screenshot of the sidebar badge and the Profile switch goes in the PR.
