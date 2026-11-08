# Workspace group: integration research (probed 2026-11-06)

Method: I ran `curl` against each server's `.well-known` OAuth metadata, and sent a POST to the MCP path to see whether it answers 401. Anything not confirmed by a probe is marked [UNVERIFIED]. I did not read any doc pages in this pass.

## notion — Notion

- URL: `https://mcp.notion.com/mcp` (streamable HTTP). There is also a legacy SSE endpoint, `https://mcp.notion.com/sse`. Both are listed in the `protected_resources` field. Vendor-hosted. The resource_name says "Notion MCP (Beta)".
- Auth: DCR is supported (`registration_endpoint: https://mcp.notion.com/register`). Scopes: `default`. The server only issues OAuth tokens. [UNVERIFIED] whether it accepts a Notion integration secret (`ntn_…`) as a bearer token. Notion's docs point token users to the local `@notionhq/notion-mcp-server` package instead.
- Proposed: `{ kind: "oauth", client: "dcr" }`, no alternative.
- Write/destructive tools: create-pages, update-page, move-pages, duplicate-page, create-database, update-database, create-comment [UNVERIFIED names]. Set them to ask by default.
- Gotchas: the token can access everything the user can see in the workspaces they choose at consent time. Some search features (Notion AI search across connected apps) need a paid plan [UNVERIFIED].

## obsidian — Obsidian (local app)

- There is no official remote MCP server, and Obsidian has no cloud API. The vault lives on the user's own machine.
- Best path: the community plugin "Local REST API" (coddingtonbear/obsidian-local-rest-api). It serves HTTPS on `https://127.0.0.1:27124` with a self-signed certificate, and optionally plain HTTP on `http://127.0.0.1:27123`. Auth is `Authorization: Bearer <api key>`, and the key is shown in the plugin's settings [UNVERIFIED port numbers/header from memory].
- MCP options:
  1. stdio `mcp-obsidian` (MarkusPfundstein, `uvx mcp-obsidian`), with env `OBSIDIAN_API_KEY`, `OBSIDIAN_HOST`, `OBSIDIAN_PORT`. It wraps the REST API. This runs today in claudebot as a **custom stdio server**.
  2. Newer versions of the Local REST API plugin ship an MCP endpoint over HTTP on localhost [UNVERIFIED]. If so, it could be a catalog entry `url: "https://127.0.0.1:27124/mcp"` with `{ kind: "bearer", tokenLabel: "Local REST API key", tokenUrl: "obsidian://" }`. claudebot would have to accept the self-signed cert (pin it, or use the plain HTTP port) and allow localhost URLs in the catalog.
  3. Filesystem-only fallback: point a filesystem MCP server at the vault folder. Needs no plugin, but has no Obsidian semantics.
- Proposed: either do not put it in the catalog and document it as a custom stdio recipe, or add a catalog entry using the localhost bearer option in item 2 once that is verified.
- Gotchas: Obsidian must be running. Self-signed TLS. Each user's vault path and key are different.

## atlassian — Atlassian (Jira + Confluence + Compass)

- URL: `https://mcp.atlassian.com/v1/mcp` (streamable HTTP; POST returns 401, so the endpoint is live). The older SSE endpoint is `https://mcp.atlassian.com/v1/sse` [UNVERIFIED still served]. Vendor-hosted "Atlassian Remote MCP Server". It reached GA in 2025 [UNVERIFIED].
- Auth: DCR is supported (`registration_endpoint: https://mcp.atlassian.com/v1/register`). Grant types are authorization_code and refresh_token. [UNVERIFIED] API-token bearer support: Atlassian later added an API-token header option for admins. Tokens are created at https://id.atlassian.com/manage-profile/security/api-tokens.
- Proposed: `{ kind: "oauth", client: "dcr" }`. Optionally add an alternative bearer pointing at the API-token page, once the header format is verified.
- Write tools: createJiraIssue, editJiraIssue, transitionJiraIssue, addCommentToJiraIssue, createConfluencePage, updateConfluencePage, createConfluenceFooterComment [UNVERIFIED names]. Set all to ask.
- Gotchas: Cloud only (no Data Center). An org admin may need to allow the MCP app or a domain allowlist [UNVERIFIED]. Rate limits depend on the plan.

## todoist — Todoist

- URL: `https://ai.todoist.net/mcp` (streamable HTTP; POST returns 401). Vendor-hosted (Doist, `todoist-ai`).
- Auth: the authorization server is `https://todoist.com`. Its metadata has `registration_endpoint` and `client_registration_types_supported: ["dynamic"]`, and also `client_id_metadata_document_supported: true`. Scope: `data:read_write`. Bearer is in the header. A personal API token (Settings → Integrations → Developer, https://app.todoist.com/app/settings/integrations/developer) is likely accepted as a bearer token [UNVERIFIED].
- Proposed: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "Todoist API token", tokenUrl: "https://app.todoist.com/app/settings/integrations/developer" } }`. Keep the alternative only if the bearer token is verified.
- Write tools: add-tasks, update-tasks, complete-tasks, delete-object, add-projects/sections/comments [UNVERIFIED names]. delete-object should ask.
- Gotchas: the OAuth AS lives on a different host from the MCP resource, so claudebot must follow `authorization_servers` from the protected-resource metadata.

## ticktick — TickTick

- URL: `https://mcp.ticktick.com` (streamable HTTP). Vendor-hosted; docs: https://help.ticktick.com/articles/7438129581631995904.
- Auth: protected-resource metadata points at the authorization server `https://ticktick.com`, whose metadata has `registration_endpoint` (`https://api.ticktick.com/oauth/register`) and `client_registration_types_supported: ["dynamic"]`; PKCE S256, `token_endpoint_auth_methods_supported` includes `none`. Scopes: `tasks:read tasks:write`. The vendor documents an API token (Settings → Account & Security → API Token) as a bearer alternative.
- Catalog: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "API token", tokenUrl: "https://ticktick.com/webapp/#settings/account" } }`.
- Gotchas: as with Todoist, the AS lives on a different host from the MCP resource; the grant types list only `authorization_code` (no `refresh_token`), so expect re-connects when the access token expires [UNVERIFIED lifetime].

## trello — Trello

- No official remote MCP server was found. `mcp.trello.com` returns an Atlassian 503 "no_healthy_upstream" page, so that hostname does not serve a working MCP server right now.
- Best option: a community stdio server, e.g. `delorenj/mcp-server-trello` (npm `@delorenj/mcp-server-trello`) [UNVERIFIED package name]. It takes env `TRELLO_API_KEY` and `TRELLO_TOKEN`. The key comes from https://trello.com/power-ups/admin (a Power-Up), and the token from the authorize URL. This works as a custom stdio server.
- Catalog: not eligible (HTTP only). Wait for an official server, which might come through Atlassian's remote MCP [UNVERIFIED].
- Gotchas: a Trello API key requires creating a Power-Up in a workspace. Tokens can be set to never expire.

## clickup — ClickUp

- URL: `https://mcp.clickup.com/mcp` (streamable HTTP) [path UNVERIFIED; issuer is `https://mcp.clickup.com`]. Vendor-hosted. Status: beta/public [UNVERIFIED].
- Auth: DCR is supported (`registration_endpoint: https://mcp.clickup.com/oauth/register`). `token_endpoint_auth_methods_supported: ["none"]` (public client + PKCE). Only `authorization_code` is listed in `grant_types_supported` and refresh_token is not, so expect re-auth when tokens expire.
- Proposed: `{ kind: "oauth", client: "dcr" }`.
- Write tools: create/update/delete task, comments, docs, time tracking, chat messages. Ask on delete and on send-message.
- Gotchas: no refresh grant, as noted above. Workspace rate limits depend on the plan.

## airtable — Airtable

- URL: `https://mcp.airtable.com/mcp` (streamable HTTP) [path UNVERIFIED; resource is `https://mcp.airtable.com`]. Vendor-hosted, official.
- Auth: DCR is supported (`registration_endpoint: https://airtable.com/oauth2/v1/register`). Scopes: data.records:read/write, schema.bases:read/write, data.recordComments:read/write, workspacesAndBases:read. The resource's `bearer_methods_supported` value was cut off in my output. Personal access tokens (https://airtable.com/create/tokens) are likely accepted as `Authorization: Bearer pat…` [UNVERIFIED].
- Proposed: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "Airtable personal access token", tokenUrl: "https://airtable.com/create/tokens" } }`. Keep the alternative only if verified.
- Write tools: create/update/delete records, create table/field (schema writes). Deletes and schema changes should ask.
- Gotchas: the AS (airtable.com) is on a different host from the resource. API limit is about 5 req/s per base [UNVERIFIED].

## Summary table

| id        | remote                       | DCR                   | proposed auth               |
| --------- | ---------------------------- | --------------------- | --------------------------- |
| notion    | mcp.notion.com/mcp           | yes                   | oauth dcr                   |
| obsidian  | none (localhost REST plugin) | n/a                   | custom stdio (mcp-obsidian) |
| atlassian | mcp.atlassian.com/v1/mcp     | yes                   | oauth dcr (+API token alt?) |
| todoist   | ai.todoist.net/mcp           | yes (AS todoist.com)  | oauth dcr + token alt       |
| trello    | none working                 | n/a                   | custom stdio only           |
| clickup   | mcp.clickup.com/mcp          | yes                   | oauth dcr                   |
| airtable  | mcp.airtable.com/mcp         | yes (AS airtable.com) | oauth dcr + PAT alt         |
