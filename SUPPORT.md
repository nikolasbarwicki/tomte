# Getting help

Tomte is maintained by one person in their spare time. There is no paid support and no response time.

## Where to ask

- **How do I…, is this expected, help with my setup:** [Discussions, Q&A](https://github.com/nikolasbarwicki/tomte/discussions/categories/q-a). Search first; someone may have asked already.
- **Something is broken:** a [bug report](https://github.com/nikolasbarwicki/tomte/issues/new/choose) with the version, how you run Tomte and the logs. The form says where they are.
- **Your own Linux server:** the [self-hosting form](https://github.com/nikolasbarwicki/tomte/issues/new/choose), after [deploy/README.md](deploy/README.md).
- **A security problem:** [private vulnerability reporting](https://github.com/nikolasbarwicki/tomte/security/advisories/new), never a public issue.

## What is not supported

- **Your Claude account.** Sign-in, plans, limits and billing are Anthropic's. Tomte only runs the Claude Code CLI with your own sign-in.
- **Remote mode on macOS or Windows.** Remote mode runs on Linux only ([ADR-0006](docs/adr/0006-remote-mode-is-linux-only.md)).
- **Exposing the host to the internet without TLS.** Put it behind a TLS proxy (`deploy/Caddyfile`) or a private network.
- **Modified builds and forks.** Reproduce on a release or on `master` first.
- **Telegram itself.** Bot tokens and Telegram's own limits are Telegram's; Tomte's side of a channel is supported.
