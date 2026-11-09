# 0008: An answer reaches the sender through an opt-in relay hook the operator configures

Status: accepted. Relates to [ADR-0007](0007-external-events-route-and-event-token.md): an external event may name where the user's answer should go, and the host delivers it only through an adapter the operator set up.

## Context

An external event is something a script, a CI job or a coordinator reports to a bot. When the user answers it (a Needs-you chip, free text, an `ask_user` card the bot raised for it), Claudebot closes the item, but the sender never hears the answer. A coordinator that asked "which database?" has to be told, with the question id it asked under, in a way it understands: for one coordinator that is a prompt to a running agent, for another a file or a webhook.

The host must stay generic (`f9e5fab` removed the Herdr and OMP coupling on purpose), and an event comes from outside: in remote mode anyone holding a bot's event token can post one, and the token is the whole credential (ADR-0007).

## Options

**(A) Bot-mediated relay.** The host gives the bot that handles the answer a relay instruction or argv built from the event's reply metadata, and the bot runs it.

- Depends on the model following the instruction, and costs a paid turn per answer.
- The bot composes a shell command from fields an event controls. The event token then steers command execution through the bot: an injection surface that no quoting rule closes, because the bot is the one that decides what to run.
- The bot's shell is sandboxed (ADR-0007): it has no loopback or local socket access, so the relay fails in the default setup and works only where the sandbox is off.
- Not observable or idempotent: the host cannot tell whether the command ran, ran twice, or ran with another text.

**(B) A generic hook the operator configures, run by the host.** After an answer is accepted, the host runs a fixed adapter named in trusted local configuration, with an argv array and no shell.

- The adapter is chosen, and its command, arguments, environment and allowed targets are fixed, by someone who can write a file on the host. No HTTP, UI or event route writes it.
- An event fills only bounded, validated slots, each a whole argv element. It never supplies a command, an argument list or an environment.
- Runs in the host process's own context, outside the bot sandbox, with a timeout and bounded output. Its outcome is stored with the event, so it is observable, retryable and once-only.
- No paid turn, and no dependence on the model.

## Decision

Option (B).

- **Reply target in the contract.** `ExternalEventInput` gains optional `reply: { kind, agent, session? }` and `questionId`. `kind` is a lowercase slug naming an adapter; `agent` and `session` are strict identifiers (`[A-Za-z0-9._:-]`, 1 to 128 characters, not starting with `-`), and `questionId` has the same shape. The route rejects anything else with a 400 naming the path. The target is adapter-neutral: `herdr` is a key in the operator's configuration and a documented example, not something the host knows.
- **Trusted configuration.** `relay.json` in the data root, or the file named by `--relay-config` / `CLAUDEBOT_RELAY_CONFIG`. It is read with Zod, refused when it is writable by group or others, and read again at every attempt, so fixing it and pressing Retry works without a restart. Each adapter has an absolute `command`, an `args` array where `{agent}`, `{session}`, `{message}`, `{answer}` and `{questionId}` are placeholders only as whole elements, a default session, an optional `allowAgents` and `allowSessions` list, a timeout and optional literal `env`. In remote mode `allowAgents` is required: a remote token holder can then choose only among agents the operator named.
- **No config, no relay.** Events and answers work as before. An event with a reply target whose answer cannot be relayed (no configuration, an adapter the configuration does not name, an agent not allowed) is shown as a failed relay and is never executed.
- **Exactly once.** The relay state lives on the stored event (`none`, `pending`, `relayed`, `failed`, with attempts and the last error). Accepting the answer closes the item and moves the relay to `pending` in one transaction, so a double click, a second device, a replayed request or a restart cannot start a second relay. A `pending` relay found at startup becomes `failed` (the host died mid-call, so delivery is unknown) and the user can retry it. Retry moves `failed` to `pending` with a compare-and-set, so a double click on Retry runs once.
- **What triggers it.** The points where the host already acknowledges an answer: a linked ask answered, and a correlated send delivered (turn start, or dequeue). Queued input is not a relay.
- **Reversible.** Because the reply target names no mechanism, option (A) can be added later behind the same metadata as another adapter kind, without a contract change.

## Consequences

- The operator owns a file that runs a program on the host with the user's privileges. The host never creates or edits it, and a sandboxed bot cannot reach it in the default setup. A bot that can write anywhere the user can has no need for it.
- **A relay can be delivered and still shown as failed.** If the adapter delivers and then exits non-zero or times out, or the host stops between the call and the write of the outcome, the user sees "Reply not delivered" and a Retry that can deliver twice. The host cannot tell: the relay is at-least-once from the user's side, at-most-once per accepted answer. A coordinator should treat the question id as the idempotency key.
- A reply is a prompt to a person or an agent, not a protocol: the answer arrives as `<answer> (<questionId>)`, or the answer alone without a question id. A message that begins with `-` is passed as written; an adapter whose program treats it as an option must put `--` before `{message}`.
- The relay does not tell the user that the coordinator acted on the answer, only that the adapter's call exited 0 (outcome "relayed").
