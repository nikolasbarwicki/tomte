# Features and their status

The single source of truth for the README's feature table; change both together.

- **Stable**: in daily use and covered by tests.
- **Beta**: works, has rough edges, or has not run on every platform.
- **Planned**: not built; see the [roadmap](roadmap.md).

| Feature                                                                            | Status  | Notes and where to read more                                                                         |
| ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Bots with their own folder, memory, model and effort                               | Stable  | Model and effort per bot; background tasks use the same                                              |
| Routines on a schedule, run headless, with a run history                           | Stable  | "Catch up" runs due routines when the computer wakes ([unverified for long sleeps](#unverified))     |
| Needs-you inbox: questions, approvals, browser takeovers                           | Stable  | [ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md)                                  |
| Unattended runs park on an approval and resume where they stopped (up to 24 hours) | Stable  | [ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md)                                  |
| Per-tool `off` / `ask` / `auto` policies on integrations                           | Stable  | [custom integrations](custom-integrations.md)                                                        |
| Browser bots with a takeover when a page needs you                                 | Stable  | [browser](browser.md), [ADR-0001](adr/0001-browser-engine-behind-host-mcp-endpoint.md)               |
| Bot handoffs: one bot asks another                                                 | Stable  | [ADR-0002](adr/0002-bot-handoffs-are-async-a2a-tasks-on-a-host-endpoint.md)                          |
| External events: scripts and CI post to a bot                                      | Stable  | [external events](external-events.md), [ADR-0007](adr/0007-external-events-route-and-event-token.md) |
| Telegram: needs-you cards, routine results, `@Name` to talk to any bot             | Beta    | [ADR-0010](adr/0010-channels-deliver-needs-you-items.md)                                             |
| Double-loop chat: a fast front that never blocks, with background agents           | Beta    | [ADR-0011](adr/0011-double-loop-chat-mode.md)                                                        |
| Chief of Staff: one bot that can propose new bots                                  | Beta    | Every proposal needs your approval                                                                   |
| Desktop app for macOS with tray, start at login and auto-update                    | Beta    | Unsigned until signing secrets exist                                                                 |
| Linux server install with HTTPS (Caddy) or Tailscale                               | Beta    | [deploy kit](../deploy/README.md), [ADR-0006](adr/0006-remote-mode-is-linux-only.md)                 |
| Windows and Linux desktop installers                                               | Beta    | Built by CI, never run yet                                                                           |
| Signed and notarized macOS and Windows builds                                      | Planned | Code exists, never run against real certificates                                                     |
| Webhook triggers for routines                                                      | Planned |                                                                                                      |
| A second harness (Codex) and other providers' plans                                | Planned |                                                                                                      |

## Unverified

Claims we have not run, so you know where the edges are:

- Windows and Linux desktop installers have not been launched on a real machine.
- Code signing and notarization have been tested against fixtures only.
- Whether a sandboxed bot on macOS can read the Claude sign-in from the keychain was never probed ([threat model](threat-model.md#known-gaps)).
- macOS auto-update of an unsigned app is not expected to work.
