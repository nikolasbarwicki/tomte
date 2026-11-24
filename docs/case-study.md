# About Tomte: the product and engineering decisions behind it

Tomte is a self-hosted host for AI bots: each bot is a Claude Code session with its own folder, memory, schedule and tools, and it keeps working when nobody watches. This page explains why it exists, what it deliberately does and does not do, and how its quality is checked. Each section links to the decision record or spec behind it, so every claim here can be traced to code.

One person builds it, with AI coding agents doing much of the typing (see [How it is built](#how-it-is-built)).

## The problem

Hosted agent products such as Grok Bot run bots that browse, write and report on a schedule. Three things about them bothered me as a user:

- **You cannot see the hood.** Memory, tool calls and permissions are hidden. When a bot does something odd, there is nothing to inspect.
- **Unattended work and approvals do not mix.** A bot that must ask before it sends an email either fails at 3 a.m. or is given permission to act without asking.
- **You pay twice.** I already pay for a Claude plan. A hosted bot product is a second subscription for the same model.

Tomte started as my own replacement: every feature my routines used, on the VPS I already rent, on the Claude plan I already have. The plan that drove that stage, with its cut-off gate and parity table, is [docs/plans/grok-bot-replacement-roadmap.md](plans/grok-bot-replacement-roadmap.md).

## Who it is for, and who it is not

One owner, on their own machine or server. That narrow scope removed whole classes of work: no accounts, no tenancy, no roles, no billing. The [comparison](compare.md) says plainly who should pick another project: a team that wants a shared workspace, Slack, or a permissive license to build a product on. The [roadmap](roadmap.md) lists what is not planned (a hosted offering, mobile apps, team workspaces) so nobody has to ask.

## Product decisions

### Use the sign-in the owner already has

Bots run on the Claude CLI's own sign-in (Pro or Max), so there is no API key and no Tomte account. The cost of that choice is a dependency on the CLI's behaviour. Tomte answers it by pinning the managed CLI version (`harness/cli.ts`), and by owning every child process's environment: billing variables from the owner's shell are stripped so a bot never bills an API key by accident, and credentials reach the CLI over a pipe, never in an environment variable or a file a bot could read (`harness/claude-access.ts`).

### An unattended run that needs you waits for you

A routine that meets a tool set to `ask` neither guesses nor fails. It **parks**: the approval becomes a durable row, the run ends its turn, and the owner gets a card in the web UI and on Telegram. The answer resumes the same session hours later, with its context intact. A park expires after 24 hours, not 30 minutes, because a park made at night must survive until the owner wakes up ([ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md), [ADR-0010](adr/0010-channels-deliver-needs-you-items.md)).

The rule that shaped the rest: **the code does not guess which tools are dangerous.** There is no list of "send" or "delete" tools. Each tool has an `off`, `ask` or `auto` policy that the owner sets. The few exceptions are fixed in code and cannot be switched off. Creating a bot always asks, even when everything else is approved. Sending mail through the built-in Gmail integration always asks, and an approval runs only the exact message the card showed ([ADR-0012](adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md)).

### A chat that never blocks

A standard chat is turn-based: while a bot researches for four minutes, you wait. The background-tasks mode puts a fast front session in charge of every message and runs heavy work in background agents that the front starts, steers and stops ([ADR-0011](adr/0011-background-tasks-chat-mode.md)). It was built as a throwaway prototype first and ported only after the prototype showed front replies in 0.7 to 3.4 seconds with agents running. The front's routing is checked by a labelled evaluation of 31 cases against the real model, gated at 90%. The last recorded run scored 30 of 31, and the miss is written up in the ADR.

### Guard the owner's plan, not just their data

Routines run at night on a machine that is always on. A routine that loops can burn a plan's limits for days. Cost guards answer that: every run records its tokens and estimated cost, a run is cut after 30 minutes of work, a routine that fails five times in a row pauses itself, and an owner who has been away for a set number of days finds their routines paused instead of running for nobody ([docs/plans/cost-guards/spec.md](plans/cost-guards/spec.md)).

### Reach the owner where they are

Telegram is the first channel because it is free, its buttons edit a message in place, and it needs no app. It sits behind a transport-neutral interface, so Web Push or Slack would be an adapter, not a rewrite. An answer from the phone goes through the same function as an answer from the web UI, so a stale card is refused the same way in both places ([ADR-0010](adr/0010-channels-deliver-needs-you-items.md)).

## Decisions that removed scope

Some of the better decisions were subtractions:

- **The credential vault was removed.** Bots could sign in to sites with stored passwords. It added a module, a settings screen, a wait kind and a secret type. A takeover, where the owner signs in once in the bot's browser, covers the same need with far less to protect. The vault and its data were deleted with a migration, with no shim left behind.
- **Remote mode is Linux only.** On macOS the Claude CLI keeps its sign-in in the keychain, and the sandbox's rules allow a bot to ask the keychain for it. Rather than claim a protection nobody verified, a server install refuses to start on macOS and Windows ([ADR-0006](adr/0006-remote-mode-is-linux-only.md)).
- **No dollar budget.** On a Claude plan the reported cost is an estimate at API prices, not money spent. The UI labels it "estimated" instead of pretending it is a bill.

## Security as part of the product

Bots are untrusted: a page a bot reads can contain instructions. The design starts from that.

- **Two listeners.** Bots and people never share a socket. Bots reach the host only with a per-session token on a loopback listener. People reach the client API with a device token they get by pairing, behind Host, Origin and content-type checks that stop other web pages and DNS rebinding ([ADR-0005](adr/0005-agent-and-client-listeners-and-device-auth.md)).
- **Sandboxed shells.** Every bot's shell runs under a deny list that hides the sign-in, the secrets store, the database and other bots' folders. On a server the sandbox fails closed.
- **Updates without giving the service root.** A server's host runs as an unprivileged user and cannot change its own binary. To update, it writes a version string to a file. A root helper verifies the signed release, swaps the binary, checks the host's health for 7 stable seconds, and rolls back by itself if the check fails ([ADR-0014](adr/0014-root-update-helper.md)).
- **A written threat model with known gaps.** [docs/threat-model.md](threat-model.md) lists who is trusted, every trust boundary and what is not protected yet.

What leaves the owner's machine, and when, is listed in [docs/privacy.md](privacy.md).

## How quality is checked

`bun run check` is the gate on every push. It runs, in order: the formatter, a type-aware linter, a dead-code check (knip), the TypeScript compiler, dependency-cruiser (which enforces the layering of [ADR-0003](adr/0003-feature-modules-and-dependency-rules.md): no import cycles, no feature reaching into another's private files, the web and desktop packages importing only the shared contract) and about 2,500 tests in 200 files (`bun test` prints the count), with a coverage floor per file.

- **Whole-host tests against fakes.** Most host tests start a whole host, with its HTTP listeners, database and composition root, against a fake Claude CLI, a fake Telegram Bot API, a fake Google and a fake release feed, all on loopback. No test touches the real network, and each fake records what it was sent, so tests assert what crossed the wire rather than mocking internals.
- **Browser smokes.** Eight smokes drive the real web UI in headless Chrome: answering from the UI, the background-tasks chat, scrolling, Telegram linking, file uploads. Desktop smokes drive the packaged Electron app, including `kill -9` with nothing left running.
- **Release integrity.** Releases ship an Ed25519-signed `SHA256SUMS`, and the installer and update helper verify it against a key pinned in the repository.
- **Honest status.** [docs/features.md](features.md) marks each feature Stable, Beta or Planned, and keeps a list of claims that have never been run, such as the Windows installer.

## How it is built

Tomte is built by one person with AI coding agents, and the process is part of the project:

- **Specs and tickets** for each feature live in [docs/plans/](plans/). Each spec states the problem, user stories and acceptance checks before code is written.
- **Decisions** that are hard to reverse are recorded as [ADRs](adr/), with the options considered and the evaluation that followed.
- **[AGENTS.md](../AGENTS.md)** is the working contract the agents follow: where each subsystem lives, which tests cover it, and which checks must pass. It is long because it is the project's memory, and it is kept in step with the code.
- **Commits** follow Conventional Commits, checked by a hook. The [CHANGELOG](../CHANGELOG.md) records changes a user would notice.

## Where to look

| To see                                      | Read                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| What it does today, and what is unverified  | [features.md](features.md)                                                                                                  |
| How it compares, and who should not pick it | [compare.md](compare.md)                                                                                                    |
| A full feature spec with user stories       | [plans/unattended-parking/spec.md](plans/unattended-parking/spec.md)                                                        |
| A decision with options and evaluation      | [ADR-0011](adr/0011-background-tasks-chat-mode.md), [ADR-0012](adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md) |
| Security boundaries and known gaps          | [threat-model.md](threat-model.md)                                                                                          |
| What leaves the machine                     | [privacy.md](privacy.md)                                                                                                    |
| What is next, and what is not planned       | [roadmap.md](roadmap.md)                                                                                                    |
