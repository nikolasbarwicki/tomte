# What leaves your machine, and where Tomte keeps your data

Tomte has no server of its own, no account and no telemetry. Everything it stores stays in folders on your machine. This page lists every network connection Tomte makes, when it makes it and what it sends, and where each piece of data lives. If code makes a connection that is not on this page, that is a bug: report it as described in [SECURITY.md](../SECURITY.md).

## Connections Tomte makes

### While bots work

| To                                                       | What is sent                                                                      | When                                                                              | Code                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Anthropic, through the Claude CLI                        | Your messages, the bot's memory and instructions, files and tool results it reads | Every bot turn                                                                    | `packages/host/src/harness/`                          |
| A custom provider you set                                | The same as Anthropic, instead of Anthropic                                       | Only while one is set (Settings → Models)                                         | `harness/claude-access.ts`                            |
| `api.telegram.org`                                       | Needs-you cards, run notices, routine results, the bots' replies to you           | Only after you save a Telegram bot token; it long-polls                           | `packages/host/src/channels/telegram/`                |
| Google (`oauth2.googleapis.com`, `gmail.googleapis.com`) | Sign-in and token refresh; the Gmail calls a bot's tools make                     | Only after you connect Gmail                                                      | `integrations/google-oauth.ts`, `integrations/gmail/` |
| Hosted MCP servers of the integrations you connect       | Whatever a bot's tool call sends, plus the provider's OAuth sign-in               | Only for integrations you connect; each tool has an `off`, `ask` or `auto` policy | `integrations/catalog.ts` lists each server's URL     |
| Websites                                                 | Page requests from the bot's browser                                              | When a bot browses                                                                | `packages/host/src/browser/`                          |

Web search and web fetch tools run inside the Claude CLI, so those requests are the CLI's and Anthropic's, not Tomte's.

### Installing the Claude CLI and the browser

| To                                     | What is fetched                                             | When                                                                                   | Code                |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| `registry.npmjs.org`                   | The pinned version of the Claude Code CLI package           | `install-cli`, and the desktop app's first launch when no CLI is found                 | `harness/cli.ts`    |
| `github.com/vercel-labs/agent-browser` | The pinned browser engine, checked against a pinned SHA-256 | `install-browser`, and the desktop app's host when the browser is missing from the app | `browser/engine.ts` |
| Google's Chrome for Testing downloads  | Chrome for Testing, through the engine's own installer      | Right after the engine is installed                                                    | `browser/engine.ts` |

The desktop app ships the browser engine and Chrome inside the app, so it normally downloads neither.

### Update checks

| To              | What is sent                                               | When                                                                                                                                                     | Code                               |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| GitHub Releases | A request for the latest release's update metadata         | Desktop app: 30 seconds after start, then every 6 hours. Off with `TOMTE_DESKTOP_UPDATES=off`                                                            | `packages/desktop/src/updates.ts`  |
| GitHub Releases | A request for the latest release's `release.json`          | A server installed from a release: at start, then every 6 hours. Never for the desktop app's own host or a host started without `/etc/tomte/update.conf` | `packages/host/src/upkeep/`        |
| GitHub Releases | The release files, checked against the signed `SHA256SUMS` | Only when you choose Update (or turn on automatic updates) on a server                                                                                   | `packages/host/src/update-helper/` |

None of these requests carries anything about you or your bots beyond what any HTTP request carries (your IP address and a user agent).

### Things you set up yourself

- **The answer relay** runs a program you configure, with the arguments you configure ([relay.md](relay.md)). What it contacts is up to that program.
- **External events** are requests other programs send to your host ([external-events.md](external-events.md)). Tomte receives them; it does not call out.
- **Connecting from another device** (a phone browser, the desktop app's connection to a server) is traffic between your own devices.

## What Tomte does not do

- It sends no telemetry, analytics or crash reports of its own.
- The web UI loads nothing from other sites: its Content Security Policy allows only its own origin (`packages/host/src/ui/serve.ts`).
- Bots get no claude.ai connectors (`ENABLE_CLAUDEAI_MCP_SERVERS=false`) and none of your own Claude Code settings, hooks or plugins.

### The Claude CLI's own traffic

Each bot turn is a Claude Code CLI process, and the CLI talks to Anthropic as Anthropic designed it, including any usage reporting Anthropic's defaults enable. Tomte turns off the CLI's self-update for the copy it manages and does not change its other defaults. Anthropic's [data usage documentation](https://docs.anthropic.com/en/docs/claude-code/data-usage) describes what the CLI sends.

## Where your data lives

| Data                                                                                     | macOS                                          | Windows                   | Linux desktop                                   | Linux server                                                                            |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Data root: the database (`tomte.db`), each bot's folder, files, memory and browser state | `~/Library/Application Support/tomte`          | `%APPDATA%\tomte`         | `$XDG_DATA_HOME/tomte` (`~/.local/share/tomte`) | `/var/lib/tomte`                                                                        |
| Secrets: integration tokens, the Telegram token, event tokens                            | The login keychain                             | The OS credential store   | The OS secret service                           | `secrets.enc` in the data root, its key in `/etc/credstore.encrypted/tomte.secrets-key` |
| Claude sign-in                                                                           | Managed by the Claude CLI (the login keychain) | Managed by the Claude CLI | Managed by the Claude CLI                       | `claude/` in the data root                                                              |
| Desktop app settings, connection profiles and logs                                       | `~/Library/Application Support/Tomte Desktop`  | `%APPDATA%\Tomte Desktop` | `~/.config/Tomte Desktop`                       | Not used                                                                                |

`--data-root` (or `TOMTE_DATA_ROOT`) moves the data root. The server paths come from the [deploy kit](../deploy/README.md).

## Removing it

Deleting the folders above removes everything Tomte stored. The [README](../README.md#uninstall) lists the steps for each platform.
