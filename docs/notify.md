# claudebot-notify

`claudebot-notify` posts one report from a script, a coordinator or CI to a bot's events route (ADR 0007). It takes the argument order of `notify-grok`, so a caller that already runs `notify-grok` switches by changing the program name. It is the package `packages/notify/` (`@claudebot/notify`); it imports only the contract and talks to the host over HTTP. For what external events are and how to start, see [external-events.md](external-events.md).

```sh
claudebot-notify [--reply <kind>:<agent> [--reply-session <session>]] <progress|question|blocked|completed|failed> <task_id> <session_id> "<message>" [question_id]
claudebot-notify --which
```

## Installing

`packages/notify/src/main.ts` is the program (`#!/usr/bin/env bun`, executable). Run it by its absolute path, or link it once:

```sh
ln -s "$PWD/packages/notify/src/main.ts" ~/.local/bin/claudebot-notify
```

Run it by path or by link, not through `bun run`, which changes the working directory; the working directory is how the project is found (below). Bun is the only requirement.

## What a report becomes

| Word        | Event kind | Effect for the user                                                |
| ----------- | ---------- | ------------------------------------------------------------------ |
| `progress`  | `progress` | A quiet row in Work; the bot is not woken.                         |
| `question`  | `question` | Needs you; the bot is woken. Reply with `Answer…`.                 |
| `blocked`   | `blocked`  | Needs you, source "Blocked" in Work; the bot is woken. `Unblock…`. |
| `completed` | `done`     | A done row the user acknowledges; the bot is woken.                |
| `failed`    | `failed`   | Needs you, source "Failed" in Work; the bot is woken.              |

- **Source**: one per project and task. The id is `notify:<readable prefix>:<24 hex of a sha-256 over [project, task]>`, so two tasks never share a source and an id cannot be forged by moving a colon. The label is `<project> · <task_id>`, or the task alone when no project is known.
- **Title**: the first non-blank line of the message, whitespace collapsed, cut to 200 characters with `…`.
- **Body**: the whole message when the title is not all of it (cut to fit 8192 characters with a marker that says how many characters are missing), then `Task:`, `Session:` and, when given, `Question ID:` lines. Quotes, backslashes, Unicode and CRLF reach the bot as written (the host wraps the text as untrusted).
- **`question_id`** travels in the body (`Question ID:`) and in the dedupe key. With `--reply` it is also sent as the event's structured `questionId`, which the answer relay appends to the answer (`docs/relay.md`); it must then be a plain name (letters, digits, `.` `_` `:` `-`, not starting with `-`, at most 128 characters), and the sender exits 2 otherwise. Without `--reply` it is free-form as before.
- **`--reply <kind>:<agent>`** (or `CLAUDEBOT_REPLY`) names where the user's answer goes back to, and `--reply-session <session>` (or `CLAUDEBOT_REPLY_SESSION`) the session on that side; the flag wins over the environment. The kind is what precedes the first colon. The host relays the answer with the operator's adapter of that kind when the answer is accepted and shows whether it arrived; the bot never sees the target. The target is part of the dedupe key, so a report with another target is another event, while the key of a report without one is unchanged. See `docs/relay.md`.
- **`blocked`** is a first-class kind: it starts `open` like a question, takes no suggested answers, and closes like one: an answer sent with the item's `eventId` (`Unblock…`, or `Status`, which sends its question as an answer too), dismissal, or an event whose `resolves` names it. The sender never sets `resolves`, so a later report does not close an earlier one; the user or the bot does.

### Dedupe and repeating on purpose

The key is `notify:v1:` plus a sha-256 over project, kind word, task, session, question id and the raw message. The same report sent again (a network retry, a script run twice) is the same key: the host answers 200 `duplicate`, delivers nothing and the sender prints `ok (duplicate)` and exits 0. Any change in those fields is a new event. To repeat an identical message deliberately, add `--salt <text>` with a value that differs per attempt (a counter or a timestamp).

## Where the URL and token come from

The first match wins:

1. `CLAUDEBOT_NOTIFY_ENV`: the path of a config file (relative paths are made absolute against the working directory).
2. `CLAUDEBOT_EVENTS_URL` and `CLAUDEBOT_EVENTS_TOKEN` in the environment, which a bot's own harness already has. One without the other is an error (exit 1); the sender does not fall back to a file.
3. `notify-<project>.env` in the config directory when it exists, else `notify.env` there.

Naming a file (1) outranks inherited variables on purpose: a caller that picks a target means it, even from inside a bot's shell. This differs from `notify-grok`, where only the file variable is checked first and there is no environment mode.

**Config directory**: `CLAUDEBOT_NOTIFY_DIR`, else `$XDG_CONFIG_HOME/claudebot`, else `~/.config/claudebot`.

**Project**, in order: `CLAUDEBOT_NOTIFY_PROJECT`; the name of the main repository of the working directory (a git worktree resolves to its main repository's name); the first path segment under `~/.herdr/worktrees/` for a directory that is no checkout (kept for `notify-grok` compatibility). A `routes` file in the config directory then remaps it: one `repo=slug` per line, first match wins, `#` comments and malformed lines are ignored. The resulting slug is also the project the report is filed under. A slug that cannot be a file name part (`/`, `\`, `..`) is an error.

**A config file** is data, never run as shell. Lines are `KEY=VALUE` (an optional `export ` prefix, `#` comments and blank lines allowed; one pair of surrounding quotes is removed; nothing is expanded). Only `CLAUDEBOT_EVENTS_URL` and `CLAUDEBOT_EVENTS_TOKEN` are read. The URL must be `http` or `https` with no credentials in it, and the token is a plain header value. Use mode `600`: a file others can read still works, with a warning (the path only) on stderr.

`--which` prints the config file that would be used (or `environment`) and exits 0 without reading it; a file that does not exist is still printed.

## Output and exit codes

stdout is `ok` or `ok (duplicate)`. Everything else goes to stderr with the prefix `claudebot-notify: `.

| Exit | Meaning                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Posted, or a duplicate of a report already posted.                                                                                                                                                  |
| 1    | Configuration: missing or unreadable file, bad line, missing or invalid URL or token.                                                                                                               |
| 2    | Usage: unknown kind or option, missing argument, an empty or multi-line identifier, a blank message. Checked before the configuration is read.                                                      |
| 3    | The request failed: no connection, no answer within 8 s, a non-2xx answer (with the status and the host's own error text), a redirect (not followed) or a 2xx that is not an events route's answer. |

Options come first; from the first positional word on, everything is an argument as written, so a message may start with `-`. `--json` of `notify-grok` is not supported.

`task_id`, `session_id` and `question_id` are identifiers: non-empty, at most 200 characters, one line without control characters. The sender refuses rather than altering one, because a changed id would stop matching what the caller keeps. `--reply`, `--reply-session` and, with `--reply`, `question_id` are stricter: names in the alphabet above, at most 128 characters, never starting with `-`, so that they can become arguments of a program without being mistaken for an option.

## Secrets

The token travels only in the `Authorization` header; it is never on the command line (so not in `ps`), never in a URL, never in a config line's error message, and any text echoed back from the host is printed with the token replaced by `[redacted]`, with control characters removed. Redirects are not followed, so the bearer cannot be sent somewhere the configuration did not name.

## The sandbox limit (ADR 0007)

A bot's sandboxed shell cannot reach the loopback route. The reporter (a coordinator, a script run by hand) has to run outside that sandbox; the sender says so when a loopback connection fails. Do not widen the sandbox, the bind address or the token's reach to make a report go through.

## Checks

Unit and host-seam tests run with `bun test` (`packages/notify/src/*.test.ts`, and `packages/host/src/events/notify-sender.test.ts`, which runs the real program against a test host). `bun run smoke:blocked-ui` drives headless Chrome against a temporary host and web build, sending reports with the real program; it is not part of `bun run check`.
