# External events

A script, CI job or coordinator can report to one of your bots. The report appears in the bot's chat and Work tab, and when it needs you it waits for an answer. The answer can travel back to the sender. Reference: [notify.md](notify.md) (sender CLI), [relay.md](relay.md) (answer relay), [ADR 0007](adr/0007-external-events-route-and-event-token.md) (route and token), [ADR 0008](adr/0008-answer-relay-hook.md) (relay).

## What you get

Each bot has its own events URL and event token. A sender posts `POST /api/bots/<botId>/events` with `Authorization: Bearer <token>`. The token posts events to that bot and nothing else. Every report has a source (sender-chosen id and label) and a kind:

| Kind       | Effect                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| `progress` | Refreshes the source in Work. Does not wake the bot and adds no chat row.       |
| `question` | Needs you; wakes the bot. `options` (up to 6, route only) become chips.         |
| `blocked`  | Needs you, source reads "Blocked"; wakes the bot. `Unblock…` and `Status`.      |
| `failed`   | Needs you, source reads "Failed". `Retry` and `Skip`.                           |
| `done`     | Needs you until acted on. `Review`. The sender word `completed` maps to `done`. |
| `stopped`  | Needs you. `Status`. Route only; `tomte-notify` has no word for it.             |

Every kind except `progress` reaches the bot as untrusted text and shows as one compact transcript row, which updates to handled, dismissed or resolved and shows the relay result.

A seventh kind, `notice`, is the host's own: it raises a notice about itself (a routine paused after 5 failed runs) from the source "Tomte". The route refuses it with 400. It never reaches the bot and has no transcript row; it counts as a Needs-you item and offers `Dismiss` only.

**Work tab** (bot panel). One card per source, most urgent first, with status, step and `done/total`. A snapshot (a step plus up to 200 items) comes only from direct route posts; each replaces the last. `tomte-notify` sends none, so its sources show events and times only. Click a card for the detail: `Status`, `Focus`, `Pause` (chat messages to the bot), items by group, and a timeline. Archive is disabled while any item is open, and the host answers 409 too. An archived source returns if it posts again.

**Needs you.** A bar above the transcript shows the count and source labels; the Work tab shows the count too. Expanded, it lists items oldest first. With it expanded, and focus not in a field, dialog or menu, and no Cmd/Ctrl/Alt: `j`/`k` move, `Enter` runs the first button, `e` dismisses. Answer with a chip, or `Answer…`, `Other…` or `Unblock…` to finish a draft in the composer. A linked `ask_user` question gets the answer; otherwise an idle bot starts a turn with it and a busy bot queues it. A queued answer does not count: the item closes only when the bot has the message. In the desktop app, a rise in open items while the window is hidden shows one notification (`<bot>: N things need you`); clicking it opens the bot.

**Dedupe and limits.** `key` (1 to 200 characters) is unique per bot: a repeat answers 200 `duplicate` and delivers nothing; a new event answers 202. Limits: body 64 KiB, `title` and source `id`/`label` 200 characters, `body` 8192, 6 `options`, 50 `resolves`, 200 `work.items`. Errors: 400 invalid (names the field), 401 bad or other bot's token or unknown bot (one answer), 403 wrong `Host`, 413 over 64 KiB, 415 not JSON.

## Quick start

1. **Get the URL and token.** Work tab, Events endpoint: Copy URL, Copy token (never shown on the page), Replace token (the old one stops at once; running sessions keep it until their next session; the new one is copied).
2. **Store them privately.** Create the file with mode 600 and paste with your editor, never on a command line:

   ```sh
   mkdir -p ~/.config/tomte
   touch ~/.config/tomte/notify.env && chmod 600 ~/.config/tomte/notify.env
   $EDITOR ~/.config/tomte/notify.env   # TOMTE_EVENTS_URL=… and TOMTE_EVENTS_TOKEN=…
   ```

3. **Install.** Bun is required. From the repo root, link it once and call it by path or link, not `bun run`:

   ```sh
   ln -s "$PWD/packages/notify/src/main.ts" ~/.local/bin/tomte-notify
   ```

4. **Send.** Argument order is `notify-grok`'s: `<kind> <task_id> <session_id> "<message>" [question_id]`.

   ```sh
   tomte-notify progress t04 omp-7 "Wave 2: 3 of 5 tickets merged"
   tomte-notify question t04 omp-7 "Use Postgres 15 or 16?" Q-1
   tomte-notify blocked t04 omp-7 "Waiting for the staging key"
   tomte-notify completed t04 omp-7 "All tickets merged"
   ```

   There is no `--options` flag. Chips come from a direct route post with `options`, or from the woken bot raising an `ask_user` card.

5. **Route per repo.** `TOMTE_NOTIFY_ENV` (a file path) wins; then `TOMTE_EVENTS_URL` plus `TOMTE_EVENTS_TOKEN`; then `notify-<project>.env`, then `notify.env` in the config directory. A `routes` file (`repo=slug` per line) remaps the project. `tomte-notify --which` prints the file it would use without sending. Details, exit codes and `--salt`: [notify.md](notify.md).

## Answer relay

The relay is operator configuration on the host (ADR 0008), not a per-bot setting in the UI. Nothing runs unless someone who can write the file set it up. Put `relay.json` in the host's data root, or give an absolute path with `--relay-config` or `TOMTE_RELAY_CONFIG`, mode 600:

```json
{
  "adapters": {
    "herdr": {
      "command": "/opt/homebrew/bin/herdr",
      "args": ["--session", "{session}", "agent", "prompt", "{agent}", "{message}"],
      "defaultSession": "default",
      "allowAgents": ["coordinator"],
      "allowSessions": ["default", "main"],
      "timeoutMs": 10000
    }
  }
}
```

The sender names the target; kind, agent and session must match the file:

```sh
tomte-notify --reply herdr:coordinator --reply-session main \
  question t04 omp-7 "Which database?" Q-3
```

When the answer is accepted, the agent receives `<answer> (Q-3)`. The transcript row and Work timeline show "Sending your reply…", "Reply delivered" (exit 0) or "Reply not delivered: <reason>" with Retry. Field reference: [relay.md](relay.md).

**Security.**

- Only the file's writer chooses what runs: an absolute command, no shell, whole-argument placeholders, no environment from events. Keep the file and program writable only by the host's user.
- Keep `allowAgents` and `allowSessions` small: anyone holding a bot's token can pick among them. Treat the token like a password.
- Remote mode (Linux only) requires `allowAgents` on every adapter.

## Known limits

- **Sandbox (ADR 0007).** A sender outside the bot can reach the loopback route. A bot's sandboxed shell cannot, though the variables are set there.
- **A crash can lose a wake-up.** The event is stored; resending its key answers `duplicate` and does not wake the bot.
- **Relay is not exactly once across a crash.** It starts at most once per accepted answer and once per Retry, but a timeout or crash can deliver and still show failed, and Retry can then deliver twice. Dedupe on the question id.
- **Herdr stalls.** With `--wait`, `herdr agent prompt` returns `agent_prompt_stalled` if it sees no work within 5000 ms, even if a short turn ran. Check the pane before Retry. The example does not use `--wait`.
- **"Delivered" means exit 0**, not that the agent acted.
- **Seen live once.** A local Claude CLI bot raised an `ask_user` card with Continue and Wait chips for an external question; the source stayed open until Continue was clicked, and it reached the Herdr pane once.
