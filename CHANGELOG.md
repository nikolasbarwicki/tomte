# Changelog

## [Unreleased]

### Added

- **Paste a long-lived token** under Settings, Models, Claude: a token from `claude setup-token` that Claude uses instead of the sign-in, billed to your Claude plan like signing in. A remote host also shows its SSH sign-in command there, so the page offers all three ways, each with its billing line and terms-risk line. The token is stored in the host's secrets backend and is never returned by the host.
- **Roll back to the previous version from Settings, About, Updates.** After an update the host keeps the one previous binary, and About offers "Roll back to 0.4.1" through the same drain and helper as an update (new messages are refused until running work has finished; **Roll back now** after 30 minutes). It is offered only when the previous version can open the database as it is. When it cannot (the update migrated the database), About instead offers "Restore 0.4.1 and its database…", which says when the pre-update copy was taken and that everything changed since is lost, and does nothing until you confirm. The release you rolled back from is skipped: it is not offered as an update and "Update automatically when idle" does not install it (that setting is left as it was) until the feed names a newer release. About says so and offers "Install 0.4.2 anyway" if you do want it; the skip survives the restart.

### Changed

- **A long-lived token is checked.** Settings, Models refuses (before sending, and the host again) anything that is not the `sk-ant-oat01-…` line `claude setup-token` prints at the end, with a message that says so; the browser code is not a token. When Claude refuses a token you saved, the host now shows Claude as signed out ("Claude rejected the long-lived token" in the banner, the tray and the channel message) until you replace or remove the token, because Claude's own sign-in check cannot tell. A restart with the same token starts out rejected.
- **Claude billing variables are no longer passed to the Claude CLI, in local mode too.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` in the host's environment used to reach every CLI child on a local host (remote mode already left them out). They no longer do, so a bot is never billed by API, or signed in through a token, by something left in the environment.
  - If you signed in through `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), the host now shows Claude as signed out until you use Sign in, or paste that token, under Settings, Models, Claude.
  - If you billed through `ANTHROPIC_API_KEY` (or a base URL and token for a gateway), bots now run on your Claude plan unless you set the custom provider in Settings, Models, which is the one deliberate way to bill by API.
  - Settings, Models, Claude names each variable the host found and ignored, and shows each method's billing line and terms-risk line.
- The installer's final message and `deploy/README.md` lead with signing in from Settings, Models; `tomte-host auth-login` over SSH is the fallback.
- **The custom provider's token now reaches the Claude CLI on a file descriptor, not in its environment** (`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are no longer set on any CLI child), so a bot's shell, a child of the CLI, cannot read it. A bearer-token provider is now handed to the CLI as a gateway token (`CLAUDE_CODE_USE_GATEWAY=1`); this has been checked against a fake provider only, so a provider that rejects that mode needs the API key form instead.
