# Custom integrations for services outside the catalog

Figma, Trello, Obsidian and Paper have no remote MCP server that claudebot can sign in to, so they are not catalog entries. Add each one with **Add custom** on the Integrations screen. Policy works as for any integration: tools the server marks read-only start on Auto, every other tool starts on Ask.

In the form, Arguments are separated by spaces and Environment takes one `KEY=value` per line.

Values marked `[UNVERIFIED]` come from research notes, not from a working connection. Check them against the tool's own settings screen.

## Obsidian

**Unofficial.** `mcp-obsidian` is a community package (MarkusPfundstein/mcp-obsidian), not made by Obsidian.

Prerequisites:

- Obsidian is running with the vault open.
- The community plugin **Local REST API** (coddingtonbear/obsidian-local-rest-api) is installed and enabled. Copy its API key from the plugin settings.
- `uv` is installed, so that `uvx` is on the PATH.

| Field       | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport   | Local command                                                                                                                                                              |
| Name        | `obsidian`                                                                                                                                                                 |
| Command     | `uvx`                                                                                                                                                                      |
| Arguments   | `mcp-obsidian`                                                                                                                                                             |
| Environment | `OBSIDIAN_API_KEY` = the plugin's API key; `OBSIDIAN_HOST` = `127.0.0.1`; `OBSIDIAN_PORT` = `27124` (the plugin's HTTPS port `[UNVERIFIED]`, shown in the plugin settings) |

## Figma

Figma's remote server (`mcp.figma.com`) accepts only clients on Figma's own allowlist, and refused claudebot's registration with 403. Use the server built into the Figma desktop app instead.

Prerequisites:

- The Figma desktop app, signed in, with a Dev or Full seat on a Professional plan or above.
- In the desktop app, open a design file, switch to Dev Mode and enable the desktop MCP server.

| Field     | Value                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Transport | HTTP                                                                                                     |
| Name      | `figma`                                                                                                  |
| URL       | `http://127.0.0.1:3845/mcp` `[UNVERIFIED]`; the desktop app shows the address when the server is enabled |
| Token     | none                                                                                                     |

## Trello

**Unofficial.** `@delorenj/mcp-server-trello` is a community package, not made by Atlassian or Trello. `mcp.trello.com` returned 503 when probed, so no official server is available.

Prerequisites:

- Node.js, so that `npx` is on the PATH.
- A Trello API key: create a Power-Up at https://trello.com/power-ups/admin and copy its API key.
- A Trello token: on the same Power-Up page, follow the link to generate a token for your account.

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Transport   | Local command                                                                 |
| Name        | `trello`                                                                      |
| Command     | `npx`                                                                         |
| Arguments   | `-y @delorenj/mcp-server-trello` `[UNVERIFIED package name]`                  |
| Environment | `TRELLO_API_KEY` = the Power-Up API key; `TRELLO_TOKEN` = the generated token |

## Paper (paper.design)

Paper's MCP server is official but local: it runs from the CLI that Paper Desktop installs. This is paper.design, not Dropbox Paper.

Prerequisites:

- Paper Desktop is running with a file open. The server only answers while a file is open.
- The CLI path, shown in Paper Desktop's MCP panel.

| Field       | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| Transport   | Local command                                                    |
| Name        | `paper`                                                          |
| Command     | the CLI path from the MCP panel, or `paper` if it is on the PATH |
| Arguments   | `mcp`                                                            |
| Environment | none                                                             |
