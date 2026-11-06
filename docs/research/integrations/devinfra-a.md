# devinfra-a integrations research (probed 2026-11-06 via curl of well-known metadata)

## sentry — Sentry
- URL: `https://mcp.sentry.dev/mcp`, streamable HTTP (SSE at /sse legacy), vendor-hosted, GA [status UNVERIFIED].
- DCR: YES — AS metadata at mcp.sentry.dev has `registration_endpoint: https://mcp.sentry.dev/oauth/register`. POST /mcp → 401 (auth required).
- Bearer: [UNVERIFIED] remote accepts only its own OAuth; Sentry user auth tokens are for the local stdio `@sentry/mcp-server` (--access-token). Tokens: https://sentry.io/settings/account/api/auth-tokens/
- auth: `{ kind: "oauth", client: "dcr" }`
- Write tools: update_issue (resolve/assign), create_project, create_team, create_dsn, update_project.
- Gotchas: self-hosted Sentry needs local stdio server with --host.

## vercel — Vercel
- URL: `https://mcp.vercel.com` (resource `https://mcp.vercel.com/`), streamable HTTP, vendor-hosted, beta/public [status UNVERIFIED]. Docs: https://vercel.com/docs/mcp/vercel-mcp (linked from resource metadata).
- DCR: YES — `registration_endpoint: https://vercel.com/api/login/oauth/register`; scope `openid`.
- Bearer: no documented token path for the remote [UNVERIFIED]. Vercel docs say client allowlist for approved MCP clients may apply [UNVERIFIED] — test DCR from claudebot.
- auth: `{ kind: "oauth", client: "dcr" }`
- Write tools: deploy_to_vercel, project/env management [UNVERIFIED names]; mostly read (deployments, logs, docs search).
- Gotchas: project-scoped URL form `https://mcp.vercel.com/<team>/<project>` exists [UNVERIFIED].

## supabase — Supabase
- URL: `https://mcp.supabase.com/mcp`, streamable HTTP, vendor-hosted, resource_name "Supabase MCP (Beta)".
- DCR: YES — AS `https://api.supabase.com`, `registration_endpoint: https://api.supabase.com/platform/oauth/apps/register`. Scopes incl. organizations:read, projects:read, projects:write…
- Bearer: YES — `Authorization: Bearer <PAT>` (personal access token) per Supabase docs [UNVERIFIED header for remote]. Create at https://supabase.com/dashboard/account/tokens
- auth: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "Personal access token", tokenUrl: "https://supabase.com/dashboard/account/tokens" } }`
- Write/destructive: execute_sql, apply_migration, create_project, pause_project, restore_project, create_branch, delete_branch, merge_branch, reset_branch, deploy_edge_function, confirm_cost. Default ask on all.
- Gotchas: query params `?read_only=true&project_ref=<ref>&features=...` scope the server — recommend read_only by default; project creation costs money.

## neon — Neon
- URL: `https://mcp.neon.tech/mcp` (SSE `/sse`), vendor-hosted. Docs: https://neon.com/docs/ai/neon-mcp-server
- DCR: YES — `registration_endpoint: https://mcp.neon.tech/api/register`, bearer_methods header.
- Bearer: YES — Neon API key as `Authorization: Bearer <key>` (documented for remote) [UNVERIFIED exact]. Create at https://console.neon.tech/app/settings/api-keys
- auth: `{ kind: "oauth", client: "dcr", alternative: { tokenLabel: "Neon API key", tokenUrl: "https://console.neon.tech/app/settings/api-keys" } }`
- Write/destructive: create_project, delete_project, run_sql, run_sql_transaction, create_branch, delete_branch, prepare/complete_database_migration, provision_neon_auth.
- Gotchas: Neon says for dev/testing only, not prod DBs [UNVERIFIED wording].

## netlify — Netlify
- URL: `https://netlify-mcp.netlify.app/mcp`, streamable HTTP, vendor-hosted (Netlify's official remote) [status UNVERIFIED; official primary is stdio `@netlify/mcp`].
- DCR: YES — `registration_endpoint: https://netlify-mcp.netlify.app/oauth-server/reg`, scopes offline_access read write.
- Bearer: Netlify PAT works for stdio via NETLIFY_PERSONAL_ACCESS_TOKEN; remote bearer [UNVERIFIED]. PAT: https://app.netlify.com/user/applications#personal-access-tokens
- auth: `{ kind: "oauth", client: "dcr" }`
- Write/destructive: deploy-site, create-new-project, update env vars, manage forms/extensions, change visibility.

## github — re-verify
- URL `https://api.githubcopilot.com/mcp/` still live; protected-resource metadata at `/.well-known/oauth-protected-resource/mcp/`: AS `https://github.com/login/oauth`, scopes repo, read:org, … .
- DCR: NO — no AS metadata at github.com/login/oauth/.well-known/oauth-authorization-server nor github.com/.well-known/* (404). GitHub OAuth apps don't support DCR.
- Keep: `{ kind: "oauth", client: "own" }` (user registers OAuth/GitHub App) + bearer PAT alternative (`Authorization: Bearer <PAT>`, https://github.com/settings/personal-access-tokens). No change.

## linear — re-verify
- `https://mcp.linear.app/mcp` (SSE `/sse`); DCR YES — `registration_endpoint: https://mcp.linear.app/register`, scopes read/write. Also accepts Linear API key as Bearer [UNVERIFIED] (https://linear.app/settings/account/security).
- Keep `{ kind: "oauth", client: "dcr" }`. Write tools: create/update issue, create comment, create project.

Sources actually read: the well-known JSON responses above (live curl). Vendor doc pages not fetched — tool names/token docs marked [UNVERIFIED] where from memory.
