# Google / Gmail OAuth: research notes

Status: research. Gmail's direction is decided in [ADR 0012](../adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md): a built-in integration on the Gmail REST API with the owner's own client. Sections 1, 2 and 4 to 7 record what was known before that decision; section 6 now states what was adopted and what was not.
Scope: how tomte should handle Gmail setup for a public release; how competitors handle it.
Gathered: against repo clones and Google docs fetched during one session. Competitor stars, plans and prices are snapshots.

Legend: **[V]** observed in a doc or in source. **[I]** inference, not observed. **[U]** unverified claim made by a vendor.

## 1. Problem

Before ADR 0012, connecting Gmail asked each user to:

1. Join the Workspace Developer Preview Program (the Gmail MCP server is Developer Preview) **[V]**.
2. Create their own Google Cloud project and OAuth client, with "Use this client for an AI-powered agent" selected **[V]**.
3. Click through a consent screen, with the unverified-app warning if the client is unverified **[V]**.

## 2. Tomte's wiring before ADR 0012 **[V]**

- `src/integrations/catalog.ts`: the Gmail entry was an own-client entry for Google's hosted Gmail MCP server. Scopes `gmail.readonly gmail.compose`. It is now a built-in entry (scope `gmail.modify`) and the hosted URL is gone from the code.
- `src/integrations/index.ts`: `connectOAuth` uses `deps.oauthRedirectUrl` (loopback `/oauth/callback`, port from `PORT`, default 5173) through the MCP SDK `mcpAuth`. A built-in server now signs in through `integrations/google-oauth.ts` instead.
- `.env`: `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- No `access_type` string existed in `src/integrations/*.ts`. The installed MCP SDK (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js`) matches only `offline_access`, and only to add `prompt=consent`; it never sets `access_type`. **[V]** by grep, not by a live Google sign-in. So tomte sent no `access_type=offline`, and Google likely issued no refresh token **[I]**. The built-in sign-in sends `access_type=offline` and `prompt=consent`; the remote Google entries (Calendar, Sheets, Docs, Drive) keep `withOfflineAccess`.

## 3. Google facts

### Gmail MCP server (`developers.google.com/workspace/gmail/api/guides/configure-mcp-server`) **[V]**

- Developer Preview. The Cloud project must be enrolled in the Workspace Developer Preview Program.
- The OAuth client needs "Use this client for an AI-powered agent". Docs describe only the Web application client type.
- Tools: `create_draft`, `get_thread`, `label_message`, `label_thread`, `list_drafts`, `list_labels`, `search_threads`, `unlabel_message`, `unlabel_thread`. **No send tool.**

### Scopes **[V]**

| Scope            | Class      |
| ---------------- | ---------- |
| `gmail.readonly` | restricted |
| `gmail.compose`  | restricted |
| `gmail.send`     | sensitive  |

### Unverified apps (`support.google.com/cloud/answer/7454865`) **[V]**

- Warning screen on consent.
- Capped at 100 new users (Composio's article says lifetime of the project).
- In Testing status, refresh tokens expire after 7 days.

### Restricted-scope verification **[V]**

- Brand verification: verified domain, hosted privacy policy.
- Demo video showing the consent flow and each scope's use.
- Changing redirect URIs after verification requires re-verification.
- Review "can potentially take several weeks" (as quoted by Composio from Google).

### Security assessment (CASA) **[V]**

- Workspace API user data policy: "Required security measures for Restricted Scopes also include following the Cloud Application Security Assessment (CASA)". Google may require periodic assessment and a Letter of Assessment.
- **Do not plan on a local-only exemption.** An earlier note in this research said it "arguably falls outside" the assessment. That reading rested on softer wording on the restricted-scope-verification page about third-party servers and should not be relied on.
- Cost and timeline: **no figures in Google's docs**. Composio's article cites third-party estimates of "a few hundred" to "a few thousand dollars" a year **[U]**, repeated at least every 12 months.

### Workspace API user-data policy / Limited Use **[V]**

- Needs: privacy policy, in-app disclosure, demo video, prompt-injection protection (Model Armor or equivalent), granular user confirmation for agentic tool calls.
- Limited Use: transfers are allowed only to provide or improve a user-facing feature that is visible and prominent, with consent, plus a few legal and security cases. Using the data to create or train general ML/AI models is banned.
- **A local token store does not keep mail local.** Each summary sends message bodies to the model provider. Whether that is a permitted transfer depends on the provider's no-training terms and on Google's reading **[I]**.
- Approved use cases include productivity apps and generative AI summaries. Whether a general-purpose agent platform fits is a gray area **[I]**.

## 4. Competitors: how each handles Gmail

Method: shallow clones of each public repo, searched for `gmail.googleapis`, `gmailmcp`, `auth/gmail`, `GOOGLE_CLIENT`, `composio`, `pipedream`, `.env.example` and docs.

| Product   | Repo / license                                       | Gmail path                                                                                                                                                                                                                                                               | Own verified Google client?                                                                                             | Where mail and tokens go                                                                   |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Rerun     | `rerun-build/rerun`, AGPL-3.0                        | Composio. Cloud uses its own Composio project and auth configs. Self-host: seeded `authConfigId`s are empty, you create a Composio auth config per toolkit (`apps/docs/self-host/services.mdx`).                                                                         | No. Only Supabase Google sign-in.                                                                                       | Rerun cloud, Composio                                                                      |
| Rakazo    | `elie222/rakazo`, Apache-2.0                         | Composio or Pipedream Connect via an operator key. Any remote MCP server with a user-supplied OAuth client (`apps/web/e2e/mcp-oauth.spec.ts` uses a Gmail MCP URL).                                                                                                      | No.                                                                                                                     | Self-hosted server holds encrypted credentials; Composio or Pipedream hold provider tokens |
| MausBot   | `milind-soni/OpenMausBot`, Apache-2.0                | Managed Composio broker, a Cloudflare Worker (`cloudflare/composio-broker`) holding a shared Composio key. Per-install token (SHA-256 in D1), proxies MCP traffic, issues short-lived connect links. BYO Composio project key as an override.                            | No. Docs: managed auth "asks the provider only for Composio's default permissions".                                     | Desktop, Maus Worker, Composio                                                             |
| OpenBot   | `nightly-labs/openbot`, PolyForm Noncommercial 1.0.0 | Google's Gmail MCP server added by hand, with a per-server "sign-in app" (admin-registered OAuth client ID/secret/scope, loopback callback `http://127.0.0.1:28417/mcp-auth`). Or a Composio listing with the user's own MCP URL and key. No Gmail entry in its catalog. | None found in public source. Privacy policy has a "Google User Data" section, likely prepared for verification **[I]**. | Local machine, then the chosen AI provider. Composio if used.                              |
| Turnstone | closed-source Mac app                                | Not researched. No public repo checked.                                                                                                                                                                                                                                  | n/a                                                                                                                     | n/a                                                                                        |

Composio's own account of managed auth (`composio.dev/content/ship-gmail-integration-in-minutes`) **[U]**:

- The Google OAuth app belongs to Composio. Users consent to "Composio", and Composio owns verification and the annual assessment.
- Trade-offs it lists: branding (consent screen says Composio), fixed default scopes, and "Email content flows through Composio's infrastructure when you call tools".
- Escape hatch: your own OAuth app, added as a Composio auth config. MausBot uses this for scopes such as `gmail.settings.basic` and `gmail.settings.sharing`.

### Patterns worth copying

- **Two tiers:** managed one-click only on the vendor's hosted or packaged path, bring-your-own as the escape hatch. MausBot defaults to its managed broker in packaged builds; source builds and self-hosters use their own Composio key. Rerun's cloud is managed; self-hosting needs your own Composio auth config. OpenBot has no managed tier: Google MCP and Composio are both bring-your-own. This does not imply tomte should default to Composio; see sections 5 and 6 (opt-in, data path disclosed).
- **Verb-class grants enforced at the bridge, not in the model** (MausBot `docs/superpowers/plans/2026-08-31-04-connector-scopes.md`): read, draft, send, modify, delete. A new grant defaults to read-only. Imported bots get no grants. Every allow/deny is logged.
- **Send gating at every level** (MausBot `docs/verification/gmail-drafts.md`): "Ask every time" holds sends at Full access. A daily send allowance is the only auto-send route. Reading and drafting never consume it.
- **Confirm cards for send/post/delete** (OpenBot `openbot.ask_ui`). Whether it is an enforced gate or a prompt convention was not checked.
- **Google token lifetime fix** (OpenBot `withGoogleOfflineAccess` in `src/backend/mcp-oauth-provider.ts`): add `access_type=offline` and `prompt=consent` to `accounts.google.com` authorization URLs. Google's metadata lists no `offline_access` scope and its access tokens last one hour. Without it, sign-in "stopped working an hour later". OpenBot's changelog says users had to sign in again after the fix.
- **Limited Use disclosure wording** (OpenBot `apps/auth-api/src/content/privacy-policy.tsx`, "Google User Data"): the transfer to the AI provider is framed as task-scoped, "not in the background", with no training of generalised models. This is OpenBot's own claim, not a Google approval.

## 5. Options for a public release

|     | Option                                                                              | Verdict                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Bring-your-own OAuth client (today). Keep as the advanced path.                     | Keep. Matches OpenBot and Rakazo's MCP path. Does not remove the friction.                                                                                                                                                         |
| B   | Tomte-owned verified OAuth client.                                                  | Defer. Needs brand verification, restricted-scope review, annual assessment, Limited Use review, and a legal entity and domain **[I]**. Ask Google about the model-provider transfer first.                                        |
| C   | Broker (Composio, or Pipedream). One-click, no Google verification on tomte's side. | Best near-term path. Opt-in, disclose the data path (mail goes to Composio, then the model provider). Do not make it the default. How a Composio session endpoint fits the catalog's `bearer` entry shape is **untested** **[I]**. |
| D   | IMAP with an app password.                                                          | Not seen in any competitor. Avoids Google OAuth verification. Mail still goes to the model provider. Not evaluated beyond that **[I]**.                                                                                            |
| E   | Closed beta on the 100-user unverified cap.                                         | Fallback only. Users still see the warning.                                                                                                                                                                                        |

## 6. Direction adopted for Gmail, and what is left

Adopted ([ADR 0012](../adr/0012-gmail-is-a-built-in-integration-on-the-rest-api.md)):

1. Option A, in a different shape: Gmail runs inside the host on the generally available Gmail REST API with the owner's own OAuth client. Setup no longer needs the Developer Preview, the Gmail MCP API or the AI-agent flag. Mail goes Google, host, model provider; no third party.
2. Verb-class grants and send-always-asks, before any managed path: each tool has a verb class (read, draft, organize, delete, send), and `send_message` is a locked tool that always asks, with no Auto and no always-allow.
3. `access_type=offline` and `prompt=consent` on Google's authorization URL, with the host refreshing the token itself.

Not adopted, still open:

4. A Composio catalog entry as an opt-in one-click path, with explicit data-path disclosure; never the default for Gmail.
5. A Limited Use-style disclosure for the model-provider transfer.
6. A verified-client project, until Google answers whether piping Gmail into Claude, or a user-chosen model, is a permitted transfer.

## 7. Open questions

- Does Google treat sending Gmail content to Anthropic, or to a user-chosen model, as a permitted Limited Use transfer? Needs an answer from Google, not from policy text.
- Does Google's refresh token for `gmail.modify` work with the built-in sign-in, and does it survive 7 days for an unverified client in "In production" status? Ticket 03 of `.scratch/gmail-native`; the result goes in ADR 0012's Evaluation.
- Does a general agent platform qualify under Google's approved Gmail use cases? **[I]** gray area.
- CASA cost and timeline for tomte specifically. No Google figure found.
- Turnstone's Gmail setup. Not researched.
- Is OpenBot's "Google User Data" policy backed by an approved Google client? Not visible in the public repo.

## 8. Sources

- Google: `developers.google.com/workspace/gmail/api/guides/configure-mcp-server`; `developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`; Gmail scopes page; `developers.google.com/workspace/workspace-api-user-data-developer-policy`; `support.google.com/cloud/answer/7454865`.
- Composio: `composio.dev/content/ship-gmail-integration-in-minutes`; `docs.composio.dev/docs/custom-app-vs-managed-app`.
- Repos: `rerun-build/rerun`, `elie222/rakazo`, `milind-soni/OpenMausBot`, `nightly-labs/openbot`.
