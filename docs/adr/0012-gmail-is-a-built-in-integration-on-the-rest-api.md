# 0012: Gmail is a built-in integration on the Gmail REST API, and sending always asks

Status: accepted. Relates to [ADR-0003](0003-feature-modules-and-dependency-rules.md) (the integrations module keeps its layer), [ADR-0009](0009-unattended-runs-park-on-durable-human-waits.md) (a routine's approval parks the run; always-allowed tools) and [ADR-0010](0010-channels-deliver-needs-you-items.md) (a channel shows the wait's own actions). The spec is `.scratch/gmail-native/spec.md`; the research is `docs/research/google-oauth-research.md`.

## Context

Gmail was a catalog entry that pointed at Google's hosted Gmail MCP server. That server is a Developer Preview. To connect, the owner had to enrol their Google Cloud project in the Workspace Developer Preview Program, enable the Gmail API and the Gmail MCP API, and mark the OAuth client "for an AI-powered agent". Google can change or withdraw a preview at any time. The server has nine tools and no send, no attachment and no trash tool, so a bot could draft a reply and never send it. And because Google defines the server and its tools, Tomte could not decide in its own code which mail actions a bot may take.

Options for a self-hosted, single-owner host:

- **Keep the hosted MCP server.** No send tool, a preview that can end, and the setup above. OpenBot works this way (Google's hosted servers plus a sign-in app the user registers), so copying it keeps all three problems.
- **A broker such as Composio.** It removes the setup, but every email passes through a third party, and the Google consent screen names Composio, not the owner's own project. It does not fit a host whose point is that the owner's data stays between the owner's machine and the owner's model provider. It stays possible as a later opt-in entry with the data path disclosed; it is not the default.
- **Gmail's REST API from inside the host, with the owner's own OAuth client.** The API is generally available, and the host defines the tools. Setup is a Cloud project, the Gmail API, a consent screen and one Web application client, which the other Google services share.
- **IMAP and SMTP.** Not evaluated beyond noting that it avoids Google OAuth and still sends mail to the model provider.

## Decision

Gmail is a **built-in integration**: an in-process MCP server inside the host that calls the Gmail REST API. To the owner it is still the "Gmail" card in Integrations.

1. **A third transport.** `IntegrationTransport` gains `{ type: "builtin", service: "gmail" }`. The integration keeps its database row, so `decide()`, tool policies, state and the Integrations screen work as they do for any integration. The server is named `gmail`, so its tools are `mcp__gmail__<tool>`. The in-process server instance cannot go in the CLI's `--mcp-config` file, so `SessionIntegrations` carries it in a field of its own, and the standard thread and the background-tasks front merge it into the SDK's `mcpServers`.
2. **Google OAuth, not MCP auth.** Sign-in is the authorization-code flow with PKCE against Google's own endpoints (`access_type=offline`, `prompt=consent`), using the shared Google client and the existing `/oauth/callback`. The integrations module refreshes the access token on every call that is inside the expiry margin, one refresh at a time. `invalid_grant`, a 401 after a refresh and a 403 for insufficient scope turn the card to needs-auth. The endpoints are a host option (`HostServerOptions.google`) used only by tests.
3. **Scope `gmail.modify`.** It covers read, drafts, send, labels and trash, and not permanent delete or settings.
4. **Tools by verb class.** Each tool has one class that sets its default policy and whether it is locked: read (`search_threads`, `get_thread`, `list_labels`, `list_drafts`, `get_attachment`) is Auto; draft (`create_draft`, `update_draft`), organize (`modify_labels`) and delete (`trash_thread`, to the trash only) are Ask; send (`send_message`) is Ask and locked.
5. **The send lock.** A tool is **locked** when its built-in definition says so, and only `send_message` is. The host, not the model and not the owner's settings, enforces it:
   - `setPolicy` refuses Auto for it (HTTP 400); Ask and Off are accepted, and a stored Auto reads as Ask.
   - `createCanUseTool` ignores the bot's always-allowed rules for it, and asks whatever `approveAll` says, in a chat, in a background task and in a routine.
   - Its approval offers Allow and Deny only; an answer naming `allow_always` is refused and stores nothing.
   - An allow lets the call run only with the exact input the card showed, and the card shows the recipients, subject and body. When the send names a draft, the host fetches the draft so the card shows its real content, and the send is refused if the draft changed after approval. On a channel an input over the 2400-character limit offers Deny only.
   - A routine's send parks the run like any other approval, and the park expires after 24 hours.

   Nothing stores the lock: it is derived from the definition, so no catalog entry or custom integration can have one, and the web card and the channel card follow the wait's own actions without a Gmail branch.

6. **Mail is untrusted text.** Read tools return mail inside an explicit untrusted-content wrapper, HTML converted to text and long bodies cut with a marker. The server logs operation names, status codes and message ids, never subjects, bodies, addresses or tokens.
7. **Names.** A custom integration may not be called `host`, `browser`, `bots`, `routines` or `gmail`. Before this, a custom server named `browser`, `bots` or `routines` would inherit the always-allow for those prefixes.
8. **Cutover.** Schema step V30 converts a hosted `catalog:gmail` row to the built-in transport in state needs-auth. Before the migrations, `openDb` removes the hosted sign-in's tokens from the secret store and keeps the owner's Google client, so signing in again needs no new client ID and secret. The hosted tools are dropped; a tool the owner had switched Off carries to the built-in tool that replaces it (the four label tools to `modify_labels`, Off if any was Off), and the other built-in tools are added at start with their default policies. Nothing keeps the hosted URL: no alias, no fallback. Calendar, Sheets, Docs and Drive stay on their hosted MCP servers and keep their preview steps.

**Data path.** Mail goes from Google to the host to the model provider. No other service sees it. A local token store does not keep mail local, because each summary sends message bodies to the model provider; whether that is a permitted transfer under Google's Limited Use rules is an open question in the research note, and it only matters for a Tomte-owned verified client, which is out of scope. With the owner's own client nothing goes to Google review, and personal accounts see Google's unverified-app warning. In Testing status Google expires the refresh token after seven days; the setup text says so.

**Rejected.** A Composio entry as the default, because of the data path and its name on the consent screen. A daily send allowance or any other route to unattended sending. Permanent delete, settings, filters and attachments on send. Several Gmail accounts per host.

## Evaluation

Ticket 03 is a person's check against real Google, with a throwaway Google Cloud project that is not enrolled in the Workspace Developer Preview Program (Gmail API enabled, one Web application client, External consent screen). Nothing here has run against real Google: every automated test uses the loopback fake in `testing/fake-google.ts`.

- Consent for `gmail.modify` succeeds with `access_type=offline` and `prompt=consent`, and a refresh token is issued: pending ticket 03 (owner).
- The Gmail REST calls the tools need (threads list and get, drafts, labels modify, trash, send, attachments) succeed with that grant; any that need another scope are named: pending ticket 03 (owner).
- For an unverified client in "In production" status, whether the refresh token still works after 7 days: pending ticket 03 (owner).
