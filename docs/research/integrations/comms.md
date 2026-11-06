# Integrations research: comms group (2026-11-06)

Probes: `curl -s <host>/.well-known/oauth-authorization-server` and `oauth-protected-resource` were run on 2026-11-06. Results are quoted below.

## slack: Slack

- Server: official and vendor-hosted. URL `https://mcp.slack.com/mcp`, transport streamable HTTP. Slack's docs treat it as generally available. [Their wording on status is UNVERIFIED.]
- Auth: OAuth 2.1 with a **user token**. The AS metadata has **no `registration_endpoint`**, so there is **no DCR**. The authorize endpoint is `https://slack.com/oauth/v2_user/authorize`, the token endpoint is `https://slack.com/api/oauth.v2.user.access`, and the token auth method is `client_secret_post`. PKCE S256 is supported. The client must be a registered Slack app with **Agents → "Slack Model Context Protocol (MCP) Server"** toggled on (per Slack docs). Only internal apps or Marketplace-published apps are accepted (per Arcade docs [UNVERIFIED by Slack text]).
- A bearer token is accepted in the header (`bearer_methods_supported: header, form`). Slack's sample sends `Authorization: Bearer <xoxp user token>`.
- Proposed `auth`: `{ kind: "oauth", client: "own", scope: "search:read.public channels:history groups:history im:history mpim:history chat:write canvases:read canvases:write users:read", steps: ["Create app at https://api.slack.com/apps?new_app=1", "Agents → enable Slack MCP Server", "OAuth & Permissions → add user scopes + claudebot redirect URL", "Copy Client ID/Secret"] }`. A possible alternative is a bearer xoxp user token taken from the same app's OAuth page after install.
- Write tools: send message (`chat:write`), create/update canvas, and file writes (`files:write`). Default these to ask.
- Gotchas: the redirect URL must be registered in the app. Slack requires https redirects, so localhost needs to be checked [UNVERIFIED]. Workspace admin approval may be needed to install the app. Tools act as the user.
- Sources: https://docs.slack.dev/ai/slack-mcp-server/developing.md, https://docs.slack.dev/ai/slack-mcp-server (search result), https://docs.arcade.dev/en/operate/governance/remote-mcp-servers/slack (search snippet), plus the curl metadata above.

## discord: Discord

- No verified official remote MCP server. A listing named "Discord (Official)" on mcpcatalog.dev is [UNVERIFIED] and is probably mislabeled. mcpyet.com says "community only".
- Best option: community stdio servers that take a bot token, e.g. `SaseQ/discord-mcp` (`DISCORD_TOKEN`, optional `DISCORD_GUILD_ID`) and `barryyip0625/mcp-discord`. These run as stdio, so they can only be custom servers, not catalog entries. The other route is a Discord REST bot integration built into claudebot.
- If something is ever added: use a bearer bot token from https://discord.com/developers/applications (Bot → Reset Token). The bot must be invited to each guild, and the Message Content intent is needed to read messages.
- Gotchas: automating a user account (self-bots) is against Discord ToS, so only use bot accounts.
- Sources: search results only (github.com/SaseQ/discord-mcp, mcpyet.com/mcp/discord). [UNVERIFIED in depth]

## telegram: Telegram

- No official MCP server, local or remote. mcpyet.com says community only.
- There are two possible models:
  - **Bot API**: a token from @BotFather goes in the URL path (`https://api.telegram.org/bot<token>/...`). The bot only sees chats it was added to or messages sent to it. This is ToS-safe and the simple choice.
  - **User account (MTProto)**: e.g. `chigwell/telegram-mcp` (Telethon, stdio). It needs an api_id/api_hash from https://my.telegram.org and a session string. It has full access to the user's chats, so the risk of an account ban for automation is higher.
- What claudebot would need: either a custom stdio server or built-in Bot API support. It can't be a catalog entry because there's no HTTP server.
- Sources: search results only. [UNVERIFIED]

## intercom: Intercom

- Server: official and vendor-hosted at `https://mcp.intercom.com/mcp` (streamable HTTP). There is also an `/sse` endpoint [UNVERIFIED path]. Status is GA [UNVERIFIED].
- Auth: **DCR is supported**. The probe returned `registration_endpoint: https://mcp.intercom.com/register` with scopes `mcp` and `operator`, `token_endpoint_auth_methods` that include `none`, and PKCE S256. A bearer token is accepted in the header (`bearer_methods_supported: header`). Intercom docs say an Intercom access token works as `Authorization: Bearer <token>` [UNVERIFIED]. That token comes from Developer Hub → your app → Authentication (https://app.intercom.com/a/apps/_/developer-hub).
- Proposed `auth`: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "Intercom access token", tokenUrl: "https://app.intercom.com/a/apps/_/developer-hub" } }`
- Write tools: mostly read/search (conversations, contacts) [UNVERIFIED]. The `operator` scope suggests write actions exist, so default writes to ask.
- Gotchas: US workspaces only at launch [UNVERIFIED]. EU/AU regions may lack MCP.
- Sources: curl metadata above.

## mailerlite: MailerLite

- Server: official and vendor-hosted at `https://mcp.mailerlite.com/mcp` (streamable HTTP) [path UNVERIFIED; host verified].
- Auth: **DCR is supported**. The probe returned `registration_endpoint: https://mcp.mailerlite.com/register`, `none` client auth, PKCE S256, and header bearer. Whether an API key is accepted as a bearer is [UNVERIFIED]. If it is, the key comes from https://dashboard.mailerlite.com/integrations/api.
- Proposed `auth`: `{ kind: "oauth", client: "dcr" }`. Add the API-key alternative only after confirming it works.
- Write tools: create/update subscribers, groups and campaigns, and **send/schedule campaigns**. Sending is destructive and external, so always ask.
- Gotchas: some features need a paid plan, and campaign sends hit real recipients.
- Sources: curl metadata above.

## outlook + onedrive: Microsoft 365 via Work IQ MCP

- Server: **official and Microsoft-hosted Work IQ MCP** at `https://workiq.svc.cloud.microsoft/mcp` (streamable HTTP). One endpoint covers Mail, Calendar, Teams, OneDrive/SharePoint files and Copilot. Tools are path-based: `fetch` / `fetch_blob` / `create_entity` / `update_entity` / `delete_entity` / `do_action` / `call_function`, `ask` / `retrieve` (retrieve is in preview) / `list_agents`, and `get_schema` / `search_paths`. Examples are `fetch /me/messages` and `do_action /me/sendMail`. Agent 365 also has a registry of per-workload MCP servers (Outlook Mail, Calendar, OneDrive, and so on) that depend on tenant licensing and admin approval [details UNVERIFIED].
- Auth: Entra ID. Protected-resource metadata: `authorization_servers: ["https://login.microsoftonline.com/organizations/v2.0"]`, scope `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask`, header bearer. Entra has **no DCR** (its openid-configuration has no `registration_endpoint`). The user must register an app in Entra (https://entra.microsoft.com → App registrations), add the Work IQ API delegated permissions (see the permissions reference), add claudebot's redirect URI, and usually get **admin consent**. Microsoft documents four broad permissions [names UNVERIFIED beyond `WorkIQAgent.Ask`].
- Proposed `auth`: `{ kind: "oauth", client: "own", scope: "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask offline_access", steps: ["Entra admin center → App registrations → New (single tenant)", "Authentication → add claudebot redirect URI (public client/PKCE)", "API permissions → add Work IQ delegated permissions; grant admin consent", "Copy Application (client) ID"] }`. Use a single catalog entry, "Microsoft 365 (Outlook, OneDrive, Teams)", rather than separate outlook and onedrive entries.
- Write tools: `create_entity`, `update_entity`, `delete_entity` (destructive), `do_action` (sendMail and similar). These should ask. `fetch*`, `get_schema`, `search_paths`, `retrieve` and `ask` are read-only.
- Gotchas: the `organizations` authority means **work/school accounts only**, so personal Outlook.com and OneDrive accounts are not supported. That would need a Graph REST or stdio route (e.g. Softeria `ms-365-mcp-server` [UNVERIFIED]). Microsoft 365 Copilot licensing may be required for `ask`/`retrieve` [UNVERIFIED]. The tenant may need Work IQ enabled, and the Work IQ service principal is auto-created on first use. Admin policy can block paths.
- Sources: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview, the Foundry quickstart page (URL extracted), the microsoft/iq-series lab03 (URL extracted), https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview (search snippet), and the curl metadata above.
