# Answer relay

When the user answers a needs-you item whose event named a reply target, the host can pass the answer back to the process that sent the event, for example a coordinator that asked a question and waits for the reply. The host does it by running a fixed program you configure, once per answer. Nothing runs unless you configure it. The decision and its alternatives are in [ADR 0008](adr/0008-answer-relay-hook.md); the overview and quick start are in [external-events.md](external-events.md).

## The two halves

**The sender names a target.** `tomte-notify` takes `--reply <kind>:<agent>` and `--reply-session <session>` (or `TOMTE_REPLY=<kind>:<agent>` and `TOMTE_REPLY_SESSION`), and the question id as its fifth argument:

```sh
tomte-notify --reply herdr:coordinator --reply-session main \
  question 05-relay omp-7 "Which database?" Q-3
```

The event carries `reply: { kind: "herdr", agent: "coordinator", session: "main" }` and `questionId: "Q-3"` (see `docs/notify.md`). The posting route refuses a target or question id that is not a plain name: letters, digits, `.`, `_`, `:` and `-`, at most 128 characters, never starting with `-`. The bot is not told the target.

**The operator configures the adapter.** `relay.json` in the data root (or the file named by `--relay-config` / `TOMTE_RELAY_CONFIG`, an absolute path):

```json
{
  "adapters": {
    "herdr": {
      "command": "/usr/local/bin/herdr",
      "args": ["--session", "{session}", "agent", "prompt", "{agent}", "{message}"],
      "defaultSession": "default",
      "allowAgents": ["coordinator"],
      "timeoutMs": 10000
    }
  }
}
```

The key under `adapters` is the target's `kind`. `herdr` here is only an example; the host knows no adapter by name.

| Field            | Meaning                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | Absolute path of the program. No shell is involved and nothing is looked up in `PATH`.                                                                                                                              |
| `args`           | The argument list. Literal text, or one of `{agent}`, `{session}`, `{message}`, `{answer}`, `{questionId}` **as a whole argument**; a placeholder inside a longer argument is refused.                              |
| `defaultSession` | The session when the event names none (default `default`).                                                                                                                                                          |
| `allowAgents`    | When present, the only agents an event may name. Required in remote mode.                                                                                                                                           |
| `allowSessions`  | When present, the only sessions an event may name (the default session is always allowed).                                                                                                                          |
| `timeoutMs`      | 100 to 120000, default 10000. The program is killed at the timeout and the relay fails.                                                                                                                             |
| `env`            | Extra environment variables with literal values. The program otherwise gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR` and `XDG_RUNTIME_DIR`; the host's tokens and keys are not passed on. |

`{answer}` is what the user sent. `{message}` is the answer followed by ` (<question id>)` when the event has a question id, and the answer alone otherwise. `{questionId}` is empty without one. A value reaches the program as one argument exactly as written, with quotes, newlines and `$(...)` intact; it is never split or interpreted. A message that begins with `-` would look like an option to the program: put `--` before `{message}` if the program supports it.

The file is read at every attempt, so correcting it and pressing Retry works without restarting the host. It is refused while group or others can write it: whoever can write it can make the host run a program. Error messages never contain its path or contents.

## What the user sees

Answering sends the answer through any of the usual paths: a Needs-you chip or the composer, to a bot that is idle (the turn starts), busy (the message queues) or waiting on a linked question (the question receives it). The relay runs **when the answer is accepted** and the item closes as `acted`, never while the message only waits in the queue. A draft's `<source> · <title>: ` prefix is not part of the answer.

The item's row in the transcript and its entry in the Work timeline then show the relay:

| State     | Shown                                   | Meaning                                                                    |
| --------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `pending` | Sending your reply…                     | The program is running.                                                    |
| `relayed` | Reply delivered                         | The program exited 0.                                                      |
| `failed`  | Reply not delivered: <reason> and Retry | No configuration, a target the adapter does not allow, exit code, timeout… |

Failures that never ran the program: no `relay.json`, an unknown adapter kind, an agent or session outside the allow lists, an answer longer than 8192 characters, an unreadable or too-open configuration. Retry runs the program again; a second Retry while one runs, or after it was delivered, changes nothing.

## Delivery guarantees

- The program is started **at most once per accepted answer** and once more per Retry. A double click, two devices, a replayed event or a restarted host do not start it again.
- It is **at least once from the user's side**: the host cannot know whether a program that timed out, was killed or died with the host delivered the message first. Those end as `failed` with "may have been delivered"; a Retry then may send it twice. Make the adapter's receiver tolerate a repeat if that matters; the question id is in the message for that.
- An answer is kept until it is delivered (so Retry has it) and dropped as soon as it is.
- A dismissed item, an answer to an item that is no longer open, and an event without a target relay nothing.

## Remote mode

A remote host relays only to adapters that list `allowAgents`; a configuration where one does not is refused. Keep `command` and the file under the host user's control, restrict `allowAgents` to the agents that should receive user answers, and remember that anyone who can post to a bot's events route can choose among them.

## Checks

`bun test packages/host/src/events/relay*.test.ts` runs the relay against a fake program that records its argument list. `bun run smoke:answers` runs the whole round trip (the real sender, the real UI in headless Chrome, a fake `herdr`) including a failed relay, Retry, duplicates and injection-safe arguments; see [docs/smoke.md](smoke.md). It is not part of `bun run check`.
