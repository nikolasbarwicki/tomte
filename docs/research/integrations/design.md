# Integrations research — design group

Probes are `curl -s` runs from 2026-11-06.

## canva — Canva
- Official vendor-hosted remote server: `https://mcp.canva.com/mcp`, streamable HTTP. GA, per the Canva dev blog dated Oct 27, 2026 ("canva-mcp-ga"). An unauthenticated POST returns 401.
- Auth: DCR works. AS metadata at `https://mcp.canva.com/.well-known/oauth-authorization-server` lists `registration_endpoint: https://mcp.canva.com/register`, auth methods including `none`, and PKCE S256. A probe registration for a public client with redirect `http://127.0.0.1:9999/cb` succeeded and returned a client_id. The PRM lists scopes such as design:content:write, folder:write, comment:write, asset:write and brandtemplate:content:write. No bearer/API-key alternative is documented for the MCP server.
- Proposed auth: `{ kind: "oauth", client: "dcr" }`
- Write/destructive tools to default to ask: create-design, generate-design, create-design-from-candidate, copy-design, merge-designs, resize-design, autofill-design, the editing transactions (start/perform/commit), create-folder, move-item-to-folder, upload-asset-from-url, create-upload-url, import-design-from-url, comment-on-design, reply-to-comment, create-brand-template-draft, publish-brand-template, remove-background, separate-image-layers, generate-image. Read-only: search-*, get-*, list-*, export-design, resolve-shortlink, help.
- Gotchas: autofill, brand templates and resize need Pro or above. Export quality depends on the plan, and premium elements can fail with `license_required`. Rate limits are set per tool (10–100 req/min), with a 300 req/min per-user cap shared across all of that user's MCP clients.
- Sources: https://www.canva.dev/docs/mcp/tools (read), search snippets for canva.dev/docs/mcp and blog canva-mcp-ga, live probes.

## figma — Figma
- Official vendor-hosted remote server: `https://mcp.figma.com/mcp`, streamable HTTP. The core server is GA. Write-to-canvas is a free beta that will later become usage-based and paid, and writing outside your drafts needs a Full seat.
- The Desktop MCP server runs locally through the Figma desktop app (it was formerly the Dev Mode server). Figma now positions it for specific org/enterprise needs. It needs a Dev or Full seat on a Professional plan or above, and Figma for Government supports only this version. It can't go in the catalog because it is local, not a remote URL. The old local endpoint was `http://127.0.0.1:3845/mcp` [UNVERIFIED, from memory]. Users could add it as a custom server.
- Auth: AS metadata (issuer api.figma.com) advertises `registration_endpoint: https://api.figma.com/v1/oauth/mcp/register`. However, my probe registration got **403 Forbidden**, because Figma only allows clients listed in its MCP Catalog, matched on the client_name sent at registration (sources: WorkOS blog, copilot-cli #4906, openclaw #102730, docker sbx #435). Token auth methods are client_secret_basic and client_secret_post only, so public clients aren't accepted. The PRM scope is `mcp:connect`. Figma's REST API accepts a personal access token (`X-Figma-Token`), but the remote MCP server does not document PAT bearer auth [UNVERIFIED that it is rejected].
- Proposed auth: none that works today. **Leave Figma out of the catalog** until claudebot is accepted into the Figma MCP Catalog (waitlist: https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021). `client: "own"` doesn't help either, because Figma's normal OAuth apps don't grant `mcp:connect` [INFERENCE from the MCP Manager doc: "Invalid scope: mcp:connect"]. Fallbacks: (a) the user adds the desktop server as a custom HTTP server on localhost; (b) a REST-based integration using a PAT (community stdio servers, e.g. `figma-developer-mcp`/Framelink [UNVERIFIED]).
- Write tools, if it is ever enabled: the write-to-canvas tools (use_figma etc. [UNVERIFIED names]), code-to-canvas, and Code Connect mapping writes.
- Gotchas: allowlist on client_name; plan/seat limits on rate limits (see the rate-limits-access page, not read).
- Sources: https://developers.figma.com/docs/figma-mcp-server/ (read), live metadata and DCR probes, search snippets for the WorkOS blog, the GitHub issues and docs.mcpmanager.ai/mcp-server-guides/figma.

## paper — Paper (paper.design)
- The "Paper" with an MCP server is **paper.design**, the HTML/CSS design tool. It has no remote server. Its MCP server is **local**: Paper Desktop serves streamable HTTP at `http://127.0.0.1:29979/mcp` while a file is open, and the CLI's stdio mode is now the recommended one (`<paper CLI path> mcp`, installed by Paper Desktop). It has no auth; it's localhost only.
- Proposed auth: none. It can't be a catalog entry (stdio or localhost only), so it would need to be a custom stdio server. If claudebot ever allows a "local preset" catalog kind, the command is `paper mcp`, with the CLI path shown in the Desktop MCP panel.
- Write tools: the agent reads and writes the open file (creates frames, tokens, images). The docs don't list exact tool names [UNVERIFIED]; default write tools to ask.
- Gotchas: Paper Desktop must be running with a file open. The free tier has MCP limits and Pro raises them (docs troubleshooting: "After upgrading MCP limits aren't reset"). WSL needs mirrored networking.
- **Dropbox Paper** is a different product, now folded into Dropbox. It has no MCP server of its own: `mcp.dropbox.com` returned nothing to my probe [UNVERIFIED whether a Dropbox remote MCP exists elsewhere]. That belongs with a Dropbox integration, not "paper". Label the catalog entry "Paper (paper.design)" to avoid confusion.
- Sources: https://paper.design/docs/mcp (read).

## mobbin — Mobbin
- Official vendor-hosted remote server: `https://api.mobbin.com/mcp`, streamable HTTP (Cline needs the explicit type, otherwise it falls back to SSE and fails). Listed in the GitHub MCP registry as `com.mobbin/mobbin`. GA-ish (official product page mobbin.com/mcp).
- Auth: OAuth with no API key. The PRM at `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp` points to the Supabase AS `https://ujasntkfphywizsdaapi.supabase.co/auth/v1` with scope `openid`. That AS metadata has `registration_endpoint: .../auth/v1/oauth/clients/register`, so DCR is advertised. I didn't run a test registration. The PRM is only at the path-suffixed URL; the root well-known 404s, so claudebot's discovery must follow the RFC 9728 path-insertion form or `WWW-Authenticate`.
- Proposed auth: `{ kind: "oauth", client: "dcr" }`
- Write tools: create_collection, save_content, add_comment. Read-only: search_screens, search_flows, search_sections, list_collections, get_collection_contents.
- Gotchas: full results need a paid Mobbin subscription [UNVERIFIED]. Image URLs expire after 30 days. Results include MCP Apps UI (the interactive gallery), which claudebot can ignore.
- Sources: https://github.com/mobbin/mobbin-mcp-server (read), https://docs.mobbin.com/mcp/features (read), live probes.

## clay — Clay (clay.com, GTM enrichment)
- Official vendor-hosted remote server: `https://api.clay.com/v3/mcp`, streamable HTTP. Each session needs the `Mcp-Session-Id` header from `initialize`. GA.
- Auth: DCR is open with no approval step, and public clients (`none`) with PKCE S256 are allowed. Loopback `http://127.0.0.1`/`localhost` redirects are allowed. Endpoints: AS `https://api.clay.com`, registration `https://api.clay.com/oauth/register`, authorize `https://app.clay.com/oauth/authorize`, scope `mcp`. Access tokens last 1h and refresh tokens **rotate**, so claudebot must save the new refresh token after every refresh. Registration is rate-limited per IP (burst 4, then 10/hour), so cache the client registration. Live AS metadata matched the docs.
- Proposed auth: `{ kind: "oauth", client: "dcr" }`
- Write/costly tools: find-and-enrich tools and custom functions **spend workspace credits**, so default them to ask. Exact tool names were not read [UNVERIFIED].
- Gotchas: the workspace admin must enable the "Unknown" MCP client toggle under Settings → MCP users → Allowed MCP clients, otherwise you get `access_denied` (re-checked on every refresh too). The consent screen shows "Unverified application". It needs a paid Clay plan with credits, and admins can set per-user credit caps.
- **Ambiguity:** clay.earth, the personal CRM, has been renamed **Mesh** (me.sh). It has its own official remote server at `https://mcp.me.sh/mcp` with OAuth (repo clay-inc/clay-mcp → mesh/mesh-mcp). Its tools search contacts and interactions; write tools are add contact/note and create/update group. I didn't probe its DCR. If wanted, it would be a separate `mesh` entry with probably `oauth`/`dcr` [UNVERIFIED].
- Sources: https://university.clay.com/docs/connect-to-clay-mcp (read), https://github.com/clay-inc/clay-mcp (read; it's the Mesh README), live probe of api.clay.com metadata.
