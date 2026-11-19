# Google group: Calendar, Sheets, Docs (+ Drive)

Precedent: `docs/research/google-oauth-research.md`. Gmail was an own-client entry on Google's hosted Gmail MCP server; it is now a built-in integration on the Gmail REST API ([ADR 0012](../../adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md)). This note covers the four services still on hosted MCP servers.

## Shared facts (all four) [V]

- Google offers **official, Google-hosted remote MCP servers**, one per product, all **Developer Preview** (Cloud project must join the Workspace Developer Preview Program). Source: https://developers.google.com/workspace/guides/configure-mcp-servers
- Transport: **Streamable HTTP**. URLs:
  - Calendar `https://calendarmcp.googleapis.com/mcp/v1`
  - Sheets `https://sheetsmcp.googleapis.com/mcp/v1`
  - Docs `https://docsmcp.googleapis.com/mcp/v1`
  - Drive `https://drivemcp.googleapis.com/mcp/v1`
  - (also Slides `slidesmcp`, Chat `chatmcp`, People `people.googleapis.com/mcp/v1`, Classroom `classroommcp`)
- **No DCR.** `curl https://<host>/.well-known/oauth-protected-resource/mcp/v1` → `authorization_servers: ["https://accounts.google.com/"]`, `bearer_methods_supported: ["header"]`. `accounts.google.com/.well-known/openid-configuration` has no `registration_endpoint` (grep count 0). No API-key/PAT path. → `auth: { kind: "oauth", client: "own" }`, as Gmail's own-client sign-in.
- Setup per project: enable REST API **and** MCP API (`calendar-json`+`calendarmcp`, `sheets`+`sheetsmcp`, `docs`+`docsmcp`, `drive`+`drivemcp`), configure consent screen + scopes, create **Web application** client with **"Use this client for an AI-powered agent"** checked (requests from clients without it are rejected).
- **One Google client can serve all of them** [V]: the guide uses the same `OAUTH_CLIENT_ID`/secret for every server in the Antigravity config and one consent screen with all scopes added. Each server is still a separate MCP connection with its own token/consent (resource differs) [I]. Tomte reuses one client across Gmail/Calendar/Sheets/Docs/Drive entries (the shared `appLabel`); the hosted entries' steps add "enable X API + X MCP API, add scopes".
- Refresh tokens: guide states Google only issues one with `access_type=offline` (+ `prompt=consent` to re-issue); `offline_access` scope doesn't work. The remote entries add it with `withOfflineAccess`; the built-in Gmail sign-in sends it itself.
- Unverified client: warning screen, 100-user cap, 7-day refresh-token expiry in Testing status (per Gmail research).

## Scope classification

`documents`/`spreadsheets` descriptions confirmed on https://developers.google.com/identity/protocols/oauth2/scopes. That page doesn't show sensitivity classes, so the classes below are [UNVERIFIED], based on Google's published policy:

- `drive.file`: non-sensitive (files the app created or the user opened with it)
- `drive.readonly`, `drive`: **restricted** (needs CASA, like Gmail)
- `documents(.readonly)`, `spreadsheets(.readonly)`, `calendar.*`: sensitive (verification required, no CASA)
  → Docs/Sheets/Drive as documented need `drive.readonly` (restricted). To stay sensitive-only, drop `drive.readonly` and use `drive.file` + `documents`/`spreadsheets`. Search-by-name tools will then probably fail on files the app didn't open [I].

---

### `google-calendar` — Google Calendar

- URL `https://calendarmcp.googleapis.com/mcp/v1`, streamable HTTP, Developer Preview, Google-hosted.
- Auth: own OAuth client, no DCR, no bearer.
- Guide scopes (read-only set): `calendar.calendarlist.readonly calendar.events.freebusy calendar.events.readonly`. The PRM `scopes_supported` also lists `calendar`, `calendar.events`, `calendar.calendarlist`, `calendar.calendars`, `calendar.acls`, `calendar.freebusy`, `calendar.readonly`, … The write tools need `calendar.events`. I couldn't find per-tool scopes on the create_event page [UNVERIFIED].
- Proposed: `{ kind: "oauth", client: "own", scope: "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events", steps: [...] }` (use `calendar.events.readonly` for read-only).
- Tools: list_events, get_event, list_calendars, suggest_time, search_events (read); **create_event, update_event, delete_event, respond_to_event** (ask). Of these, delete_event is destructive, and respond_to_event and create_event (invites) notify other people.

### `google-sheets` — Google Sheets

- URL `https://sheetsmcp.googleapis.com/mcp/v1`, streamable HTTP, Developer Preview.
- Guide scopes: `drive.readonly drive.file spreadsheets.readonly spreadsheets`. The PRM lists `drive.readonly spreadsheets.readonly drive spreadsheets`. The update_values page lists `drive`, `drive.file`, `spreadsheets`.
- Proposed: `{ kind: "oauth", client: "own", scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets" }`
- Tools: get_spreadsheet, get_values (read); **update_values, update_formulas, update_spreadsheet (batchUpdate: can delete sheets/ranges), insert_dimension** (ask). The reference page uses MCP annotations; update_values is marked destructiveHint ❌.

### `google-docs` — Google Docs

- URL `https://docsmcp.googleapis.com/mcp/v1`, streamable HTTP, Developer Preview.
- Guide scopes: `drive.readonly drive.file documents.readonly documents`. The PRM lists `drive.readonly documents.readonly drive documents`.
- Proposed: `{ kind: "oauth", client: "own", scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents" }`
- Tools: read_doc (read); **update_doc** (ask).

### `google-drive` — Google Drive (bonus)

- URL `https://drivemcp.googleapis.com/mcp/v1`, streamable HTTP, Developer Preview.
- Guide scopes: `drive.readonly drive.file`. The PRM lists `drive drive.readonly drive.file`.
- Tools: search_files, list_recent_files, get_file_metadata, get_file_permissions, read_file_content, download_file_content (read); **create_file, copy_file** (ask). There's no delete tool.

## Gotchas

- Every server is Developer Preview: the user's Cloud project must enroll, and access can change. Not GA.
- Restricted `drive.readonly` is required for full Docs/Sheets/Drive search. Any tomte-owned verified client would need CASA (same blocker as Gmail).
- Workspace admins can block third-party apps or the API. The rejection troubleshooting points to Admin OAuth logs.
- Service accounts with domain-wide delegation and Apps Script are handled differently (see the troubleshooting section). Not relevant to the loopback flow.
- Redirect URI: the client must list tomte's loopback `/oauth/callback`. Google Web clients accept `http://localhost:<port>` redirects [I, already working for Gmail].

## Sources read

- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server, …/sheets/…, …/docs/…, …/drive/api/guides/configure-mcp-server
- https://developers.google.com/workspace/calendar/api/v3/reference/mcp (+ tools_list/create_event)
- https://developers.google.com/workspace/sheets/api/reference/mcp (+ tools_list/update_values)
- https://developers.google.com/workspace/docs/api/reference/mcp, https://developers.google.com/workspace/drive/api/reference/mcp (+ tools_list/create_file)
- https://developers.google.com/identity/protocols/oauth2/scopes
- Live curl: PRM for the four hosts; accounts.google.com OIDC config
