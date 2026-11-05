# Glossary

- **Bot**: a persistent agent in claudebot with its own settings, memory and sessions.
- **Harness**: the agent runtime a bot runs on (Claude Code today; Codex and OpenCode later).
- **Engine**: the browser automation runtime (`agent-browser` daemon plus Chrome) that the host drives.
- **Browser session**: one bot's browser: an engine session named after the bot, with its own cookies, storage, tabs and saved login state.
- **Browser tools**: the MCP tools exposed to bots at the browser endpoint.
- **Browser endpoint**: the host's Streamable HTTP MCP route that serves the browser tools.
- **Snapshot**: a text accessibility view of the current page with element references (refs).
- **Live view**: the user's real-time view of a bot's browser in the web UI.
- **Takeover**: a period during which the user, not the bot, controls a bot's browser.
- **Credential entry**: a stored website login (label, site origin, username, password) in the claudebot vault.
- **Grant**: the user's permission for one bot to use one credential entry.
- **Human wait**: anything that needs the user before the bot can continue (takeover, credential approval).
