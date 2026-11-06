# devinfra-b (probed live 2026-11-06 via curl; vendor docs not re-read → doc-derived claims [UNVERIFIED])

## railway — Railway
- URL https://mcp.railway.com/mcp (streamable http, vendor-hosted). POST → 401 `scope="workspace:member"`.
- DCR: YES — AS https://backboard.railway.com, registration_endpoint /oauth/register.
- auth: `{kind:"oauth", client:"dcr"}`
- Destructive: deploy, delete service/env, set variables [UNVERIFIED tool names].
- Gotcha: older local `@railway/mcp-server` (CLI-based) exists; remote is the one to use.

## render — Render
- URL https://mcp.render.com/mcp (streamable http, vendor-hosted). 401 with resource_metadata → AS https://api.render.com, NO registration_endpoint (api.render.com/.well-known/oauth-authorization-server absent).
- auth: `{kind:"bearer", tokenLabel:"Render API key", tokenUrl:"https://dashboard.render.com/u/settings#api-keys"}` (header `Authorization: Bearer <key>`).
- Destructive: create services/DBs, update env vars [UNVERIFIED]; mostly read + create.
- Gotcha: key is account-wide; user must select workspace via tool first [UNVERIFIED].

## stripe — Stripe
- URL https://mcp.stripe.com (root path; /mcp returns 404). Streamable http, vendor-hosted.
- DCR: YES — issuer access.stripe.com/mcp, registration_endpoint https://access.stripe.com/mcp/oauth2/register, PKCE S256, scope `mcp`, public clients.
- auth: `{kind:"oauth", client:"dcr", alternative:{tokenLabel:"Stripe restricted key (rk_…)", tokenUrl:"https://dashboard.stripe.com/apikeys"}}` (Bearer header).
- Destructive: create refunds, cancel subscriptions, create payment links/invoices/customers → default ask for all writes.
- Gotcha: recommend restricted keys / test mode.

## resend — Resend
- URL https://mcp.resend.com/mcp (streamable http, vendor-hosted). PRM → AS https://api.resend.com.
- DCR: YES — registration_endpoint https://api.resend.com/oauth/register.
- auth: `{kind:"oauth", client:"dcr", alternative:{tokenLabel:"Resend API key", tokenUrl:"https://resend.com/api-keys"}}` (bearer alternative [UNVERIFIED] — PRM says bearer header supported).
- Destructive: send email/broadcast, delete contacts/domains → ask.

## firecrawl — Firecrawl
- URL https://mcp.firecrawl.dev/v2/mcp with `Authorization: Bearer fc-…`; also key-in-path form https://mcp.firecrawl.dev/{API_KEY}/v2/mcp [UNVERIFIED exact path]. POST /mcp → 406 (server alive), no OAuth metadata.
- DCR: NO.
- auth: `{kind:"bearer", tokenLabel:"Firecrawl API key", tokenUrl:"https://www.firecrawl.dev/app/api-keys"}`
- Tools are read-only scraping/crawl/search; cost credits (crawl can be expensive → ask on crawl).

## cloudflare — re-verified
- https://mcp.cloudflare.com/mcp: 401, DCR YES (registration_endpoint https://mcp.cloudflare.com/register), scopes granular. Existing entry OK.

## posthog — re-verified
- https://mcp.posthog.com/mcp: 401 → PRM AS https://oauth.posthog.com, DCR YES (/oauth/register/). Existing entry OK. EU users may need https://mcp-eu.posthog.com [UNVERIFIED].

Sources: live curl of each /.well-known endpoint and WWW-Authenticate headers above.
