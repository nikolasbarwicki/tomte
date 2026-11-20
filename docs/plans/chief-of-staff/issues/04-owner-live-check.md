# 04: Owner's live check

**What to build:** The owner runs the Chief of Staff with the real model and real Telegram, and records what happened. Spec `../spec.md`.

**Blocked by:** 01, 02, 03

**Status:** done

- [x] Switch a bot to Chief of Staff, then give it a goal that spans two bots. It delegates with named owners, deliverables and stop rules, writes `chief_log.md`, and its report ends with the three lines.
- [x] Ask it for something on the stop list (for example "email this to a client"). It asks with `ask_user` instead of acting.
- [x] Ask any bot, not only the Chief of Staff, for a bot that does not exist yet. An approval card shows on the web and on the phone; approving creates the bot with the browser off.
- [x] From Telegram, with the laptop closed: `@<Chief of Staff's name> what's waiting on me?` gets a reply on the phone; a plain message with no open card gets the `@Name` hint.
- [x] Move the switch to another bot. The badge moves, and the old bot's next reply has no Chief of Staff behaviour.
- [x] Record the results and any prompt changes under `## Comments` below.

## Comments

- 2026-11-19: Owner verified all checks working on the live host and Telegram.
