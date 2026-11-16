# Rakazo research (2026-11-13)

## What it is

- Open-source platform for "persistent AI bots": each bot has its own conversations, memory, routines and a "computer" (sandbox with browser + shell). You talk to them in web, desktop, and mobile apps, Slack/Teams, or chat apps. Its tagline is "Open-source Grok Bot alternative. Choose your own model and sandbox." (rakazo.com; github.com/elie222/rakazo description).
- Repo: https://github.com/elie222/rakazo. License: **Apache-2.0** (LICENSE, root package.json). 8,251 stars and last push 2026-11-13T20:18Z (gh api). The latest commit was 2026-11-13 (#4577), so the repo is very active with 4.5k+ PRs. Maintainer: Elie Steinbock (GitHub `elie222`) [INFERENCE: individual GitHub handle; company entity not verified].
- The landing page has 8 templates: Sales Outbound, Inbox Manager, Talent Scout, Expense Manager, Coding Agent, Account Manager, Paid Media, and Chief of Staff (rakazo.com).

## Infra / self-hosting / laptop-off behavior

- Architecture: a long-running API (Hono/oRPC), a **Graphile Worker** job queue on **Postgres**, the web app, and a computer provider. "It is not a static site." (docs/self-host.md)
- Ways to self-host:
  - (a) A one-line installer pulls `ghcr.io/elie222/rakazo/app` plus Postgres via Docker Compose (`install-images.sh`, multi-arch amd64/arm64).
  - (b) A source checkout with `docker compose ... up --build` or `pnpm dev`.
  - (c) The desktop app's "This computer" mode. On Apple silicon with macOS 26+, it runs a Docker-free stack. This stack stops when the app quits; Docker containers keep running (docs/self-host.md).
  - Production single-VM path with Caddy TLS, systemd backup/host-check timers, and a Railway template (`infra/railway`, `railway.json`). There is also a Fly preview (`infra/preview/fly.toml`).
- Laptop-off: the site says "Keeps working while your computer is off" (Self-hosted section, rakazo.com). The mechanism is a server-side scheduler and queue (`WAKEUP_DRIVER=graphile`, docs/self-host-configuration.md; `routine-*.ts`, `wakeup.ts` in packages/adapters/src). Bots wake "on a schedule, a webhook, a GitHub event, or a change it watches" (rakazo.com). There is also a per-bot inbound email address that triggers routines (docs/self-host.md → self-host-inbound-email.md). This only holds if the server runs on a VPS or in the hosted cloud, not in laptop desktop mode [INFERENCE].
- Hosted option: app.rakazo.com ("Cloud: Beta"). It gives you a cloud computer that pauses when idle, up to 5 computers running at once, and EU hosting (rakazo.com FAQ; /pricing).
- Sandboxing: bot computers are sibling Docker containers (`rakazo/computer:local`) on separate per-bot networks. A token-protected sandbox supervisor owns the Docker socket, so the API does not get it (docs/self-host.md). The pricing page lists 13 alternative providers: Docker, Kubernetes, Incus, Boat, Boxd, CreateOS, Daytona, E2B, InstaBox, Novita, Railway, Wuying, and Apple container. Each has an adapter (`*-sandbox.ts`). You can also use your own computer through the desktop app (host-computer-*.ts). Computer egress can be restricted (`infra/compose/restrict-computer-egress.sh`).
- Data and secrets:
  - Data lives in Postgres via Prisma.
  - Credentials are encrypted with `ENCRYPTION_KEY`. Optional AWS KMS and Infisical secret stores are supported (`aws-kms-key-provider.ts`, `infisical-secret-store.ts`), as is S3 object storage.
  - Memory: built-in memory, or pluggable Supermemory, Honcho, or Hindsight, which can be self-hosted (docs/self-host-integrations.md).
  - Approval rules: an "Approval model" can auto-review actions (docs/models).

## Claude / Codex subscription use

- **ChatGPT/Codex: supported officially.** Use Settings → Models → OpenAI Codex → "Sign in with ChatGPT". It uses the eligible plan's Codex allowance (docs/model-subscriptions).
- **Claude: technically present, officially discouraged.** The docs say: "Although Rakazo currently exposes a Claude sign-in option, Anthropic's published rules prohibit third-party apps from offering Claude account login or routing their own requests through consumer subscription credentials. We do not recommend that path." They recommend an Anthropic API key instead (docs/model-subscriptions; FAQ on rakazo.com).
  - The code does Claude.ai OAuth directly, without the claude CLI: `packages/adapters/src/pi-anthropic-oauth.ts` uses `https://claude.ai/oauth/authorize`, token URL `platform.claude.com/v1/oauth/token`, and scopes including `user:inference user:sessions:claude_code`.
  - A user testimonial on the site: "using rakazo for 1 month in claude oauth no problems yet".
- OpenCode Go API key (for coding-agent workloads) and OpenCode Zen are supported (docs/model-subscriptions).
- Other providers:
  - API keys for OpenAI, Anthropic, Google, OpenRouter "and many others".
  - Any OpenAI-compatible URL (Ollama, LM Studio, vLLM), with a protocol switch to Responses or Anthropic Messages.
  - Fallback model chain, plus a different model per bot and per routine (docs/models).
  - The site also lists Grok.
- The model layer is the `@earendil-works/pi-ai` / `pi-agent-core` runtime (packages/adapters/package.json).
- Hosted option: "Rakazo credits" at provider price with no markup (/pricing).

## MCPs / apps / integrations

- **MCP client:**
  - Remote HTTPS MCP servers with OAuth (dynamic registration, or a user-supplied client ID/secret).
  - "Browse MCP servers" public directory.
  - Stdio MCP servers, admin-only, gated by `MCP_STDIO_ENABLED` and an allowlist.
  - Also OpenAPI/GraphQL connectors, an "Executor" tool gateway, and plugins installed from GitHub (docs/integrations.md, docs/self-host-integrations.md).
  - Code: `mcp-*.ts`, `@modelcontextprotocol/sdk`. A plugin marketplace exists (`plugin-marketplace.ts`). MCP _server_ exposure: [UNVERIFIED].
- **Gmail/Calendar/Notion/GitHub etc.:** you connect apps from chat ("connect my Google Calendar" posts a Connect card) or from Integrations. The managed app catalog runs through **Composio** (`COMPOSIO_API_KEY`) or **Pipedream** (`PIPEDREAM_CLIENT_ID/SECRET/PROJECT_ID`). Self-hosters only see the catalog if they configure one of these (docs/integrations.md; docs/self-host-integrations.md:137-139). Connected apps are shared across all bots in a "space".
- **Channels:**
  - Slack and Microsoft Teams, on cloud and self-hosted.
  - iMessage & SMS, WhatsApp, and Telegram: self-hosted only (rakazo.com).
  - Code also has Lark/Feishu (`lark`, `@larksuiteoapi/node-sdk`).
  - iMessage goes through Photon (`@photon-ai/chat-adapter-imessage`) and SMS via Sendblue (`sendblue-emulator.ts`).
  - Other adapters come from `@chat-adapter/{slack,teams,telegram,whatsapp}`.
  - Bots can also be reached by email and through web/desktop/mobile apps.
- **Other:**
  - Browser and computer use, with screen view and takeover.
  - "Learns by watching": you demonstrate a task once and it is saved as a skill (`teaching-session.ts`).
  - Skills.
  - Bots delegate to each other and form groups (`child-bots.ts`, `group-handoff.ts`, `fleet-tools.ts`).
  - Voice calls to you in the app (ElevenLabs, Cartesia, xAI, OpenAI voice).
  - Cloud coding agents: Cursor, T3 Code.
  - Payment wallets and purchases (Stripe MPP).
  - Media generation.

## Monetization

(/pricing, seen 2026-11-13)

- **Self-hosted:** Free, Apache-2.0, any model, 13 sandbox options, unlimited bot computer.
- **Hosted "Your model" (BYO Claude/ChatGPT/API key):**
  - Standard $15/mo ($12/mo billed yearly): 25 computer-hours/mo, 4 vCPU / 8 GB.
  - Pro $49/mo: 100 h, 8 vCPU / 16 GB.
  - Max $99/mo: 200 h, 16 vCPU / 32 GB.
  - All tiers: 7-day free trial with 10 computer-hours. Hours count only while the bot uses its computer; no overage charges (FAQ).
- **Rakazo credits:** from $20/mo. Model usage is billed at provider price with no markup, from 20 computer-hours ($30 → 30 h). Top up anytime.
- **Enterprise:** SSO, SCIM, audit log, encryption at rest, and approval rules on your own infrastructure. Price not listed (rakazo.com/enterprise index).
- Stripe billing is part of the open-source code (`stripe-billing.ts`, docs/self-host-billing.md), so the business model is open source plus a hosted SaaS, not open-core [INFERENCE].

## Differentiator

- Very broad pluggable **sandbox layer**: 13 computer providers, including Kubernetes, Incus, Apple container, E2B, Daytona, and Alibaba Wuying, plus your own machine through the desktop app. Each bot gets a full desktop with browser and screen takeover.
- **Multi-bot "team" model**: role templates, spaces shared across a team, bots delegating to each other and working in groups, team memory, and approval rules with an AI "approval model". Enterprise features (SSO/SCIM/audit log/SIEM) live in the OSS repo.
- **Native apps everywhere**: Electron desktop, Expo iOS/Android with push and VoIP calls ("It calls you"), and web.
- Honest documentation on provider ToS. ChatGPT sign-in is officially supported. The Claude OAuth path exists in code but is explicitly not recommended.
- Mature engineering signals: 8k stars, 4.5k+ PRs, extensive tests (`*.test.ts`, postgres tests, e2e/evals harnesses), and production-ops scripts (backups, PITR, host hardening).
- Concerns:
  - Large and complex surface area.
  - The hosted cloud is labelled "Beta".
  - Requires Node ≥24 and pnpm 12.
  - The app catalog needs a third-party Composio or Pipedream account when self-hosting.
  - iMessage, WhatsApp, and Telegram are self-host only.
  - Claude subscription use carries ToS risk, per the project's own docs.

## Tech stack

- **Language and tooling:** TypeScript monorepo. pnpm 12.18 workspaces with Turborepo. Node ^24.15 or ≥26. Biome, Vitest, Lingui i18n (package.json, turbo.json).
- **Apps:** `api` (Hono + @hono/node-server + oRPC), `worker` (Graphile Worker), `web` (React + Vite + React Router + TanStack Query + Tailwind + better-auth with passkeys), `desktop` (Electron + electron-updater + koffi), `mobile` (Expo / React Native with expo-router), and `www` (marketing site).
- **Packages:** core, db, adapters, memory, auth, contracts, chat-ui, and others.
- **Data:** Postgres via Prisma 7 (`@prisma/adapter-pg`); Graphile Worker queue. Optional S3 object storage, AWS KMS, Infisical.
- **Agent runtime:** `@earendil-works/pi-ai`, `pi-agent-core`. MCP via `@modelcontextprotocol/sdk`. OpenTelemetry and Sentry.
- **Sandbox:** Docker image `infra/sandboxes/computer` (Linux desktop), a supervisor, and SDKs for E2B, Daytona, Kubernetes, Boat, Boxd, Novita, InstaBox, and Alibaba.
- **Deploy:** Docker Compose (GHCR images), Caddy, systemd, Railway, Fly preview.

## Sources

- https://rakazo.com/ (landing, FAQ, site index)
- https://rakazo.com/pricing.md
- https://rakazo.com/docs/models.md
- https://rakazo.com/docs/model-subscriptions.md
- https://github.com/elie222/rakazo (cloned depth 1 at commit #4577, 2026-11-13). Files used: package.json, LICENSE, apps/_/package.json, packages/db/package.json, packages/adapters/package.json, packages/adapters/src/ (pi-anthropic-oauth.ts, *-sandbox.ts, composio-connector.ts, pipedream-connector.ts, mcp-*.ts, routine-_.ts, wakeup.ts), docs/self-host.md, docs/self-host-integrations.md, docs/self-host-configuration.md, docs/integrations.md, infra/
- gh api repos/elie222/rakazo (stars, pushed_at)

## Deep-dive: browser, secrets, crons (2026-11-13)

(Source: github.com/elie222/rakazo, cloned depth 1 to /tmp/rakazo-deep on 2026-11-13. Paths below are relative to the repo.)

### 1. Agent browser

- **Tech:**
  - Each bot computer runs real **Chromium**. The default build is `ARG BROWSER=chromium`; `BROWSER=chrome` (amd64 only) or `brave` are also possible. It runs **headed** on **Xvfb + fluxbox**, with **x11vnc + noVNC** for viewing (`infra/sandboxes/computer/Dockerfile` l.1-3, 54-70).
  - It is driven over **CDP via Vercel `agent-browser`**, which is pinned and sha256-checked (`infra/sandboxes/computer/install-agent-browser.sh`; docs/computer-runtime.md). No Playwright, Puppeteer or Browserbase is used in the default path.
  - `BROWSER_PROVIDER=fake|emulator` exists only for tests (`browser-provider-factory.ts`, `fake-browser.ts`).
- **Where it runs:**
  - Inside the bot's computer, which is a Docker sibling container or a remote sandbox: E2B (`@e2b/desktop`), Daytona, Boat, Novita, K8s and others.
  - The same Linux desktop runtime is used everywhere (docs/computer-runtime.md "E2B/Daytona/Boat backend").
  - The desktop app can also let bots use **the user's own machine** ("Let bots use this computer"). This is screen and app control on Mac and Windows through Accessibility/Screen Recording permissions (`host-screen.ts`, `cua-host-screen.ts`). The user's normal Chrome profile is not driven through CDP [INFERENCE from docs/computer.md: that doc describes apps and screen, not a browser-profile API].
- **Profiles:**
  - Each Team bot gets its own X display and Chrome process. Each has a **persistent Chrome profile keyed to the bot's identity**: cookies and logins are independent per bot, never cloned or merged, and kept across sleeps (docs/computer-runtime.md "Computer contract").
  - Profiles live under the portable workspace (for example `.browser-profiles` on E2B) and are checkpointed into `AgentHomeStore` at run end and before idle stop.
  - There is a contradiction: user docs say that on a Team computer "sites you sign in to are carried over to the other bots" (docs/computer.md). The runtime doc says profiles are independent. Use a **Private** computer for isolation.
  - Team bots share an OS user, so the profiles are not a security boundary (docs/computer-runtime.md).
- **Watch and take over:**
  - The "Agent computer" panel shows a live noVNC view, on web, desktop and mobile.
  - **Take control** gives the user an exclusive control lease. It is refused with HTTP 409 while the bot runs, unless the run is `waiting_takeover`.
  - The bot can call `request_takeover` (header shows "Needs you", then I'm done/Skip) for a CAPTCHA, SMS code or passkey (docs/computer.md; `packages/adapters/src/browser-tools.ts`).
  - Screen URLs are short-lived capabilities signed with `SCREEN_PROXY_SECRET` (docs/self-host-secrets.md).
- **Logins:** there are three ways to log in:
  - (a) The user logs in manually through takeover.
  - (b) **Saved website logins** (`request_secret` with `auth.type: "login"`, 1-8 fields, optional TOTP authenticator key). The bot fills them with `browser_act` `{kind:"fill_secret", ref, secret, field}`. The backend decrypts the value and the page browser types it **only if the page is still on the saved HTTPS origin**, or one of up to 10 owner-added exact origins. The **LLM never sees the value** (docs/bot-secrets.md; `page-browser-login-fill.test.ts`).
  - (c) **Payment cards** via `fill_card`; the model sees only brand and last four digits (docs/bot-secrets.md).
  - There is no cookie import or external password manager. The Chromium policy disables its built-in password manager and autofill (`infra/sandboxes/computer/browser-policy.json`).
- **Tool surface:**
  - Native Pi tools, not MCP:
    - `browser_navigate`, `browser_snapshot` (page text plus element refs), and `browser_act` (refs are re-checked against a fresh snapshot).
    - Screen tools: `computer_observe` (screenshots) and batched `computer_act`.
    - Also `shell`, `open_path` and `launch_app`.
  - An optional separate **Computer-use model** role (`enter_computer_mode`/`leave_computer_mode`) lets a vision model work the screen for a text-only main model (docs/computer-runtime.md).
- **Safety:**
  - CDP binds to container loopback only.
  - There is no agent-browser domain allowlist; navigation policy lives in the helper (docs/computer-runtime.md).
  - Purchase presses are recognized and always ask, and a spending limit is enforced (docs/approvals.md).
  - Docker computers can have **restricted egress**: internet allowed, but no Docker host, LAN or 169.254.169.254 (`SANDBOX_COMPUTER_EGRESS=restricted`, `infra/compose/restrict-computer-egress.sh`, docs/self-host-docker-computers.md).
  - Prompt injection is handled by reducing permissions after outside content arrives. Routines started by webhook, email or Slack get change-tools checked and purchases refused (docs/routines.md note; docs/approvals.md).
  - No stealth or anti-bot fingerprinting was found. CAPTCHAs go to a human takeover. [UNVERIFIED that there is no stealth anywhere; grep for "stealth" in docs found nothing.]

### 2. Credentials / secrets

- **Storage:**
  - Everything is in Postgres. Credentials (`secrets`, `bot_secrets`, `integration_provider_configs`, `vault_credentials`) are encrypted with **`ENCRYPTION_KEY`**, which the installer generates with `openssl rand -hex 32` (docs/self-host-secrets.md).
  - After `content-encryption migrate`, vault items use **envelope encryption**:
    - Per-vault 256-bit keys in `space_keys` (`user:<member>` / `vault:<space>`), wrapped with AES-256-GCM by master keys.
    - Master keys come from `ENCRYPTION_MASTER_KEYS` or are derived from `ENCRYPTION_KEY`, or come from **AWS KMS** (`MASTER_KEY_PROVIDER=aws-kms`, `aws-kms-key-provider.ts`).
    - AAD binds table, column, row, member and vault. The ciphertext format is `rkz1:<keyid>:<b64url(iv|ct|tag)>` (docs/content-encryption.md "How it works").
  - Optional **Infisical** secret store (`SECRET_STORE`, `infisical-secret-store.ts`, docs/infisical-secrets.md).
  - Chats, memory and artifacts are encrypted at rest as well. Routine prompts and names stay plaintext (docs/content-encryption.md).
- **Model, MCP and integration tokens:**
  - Model keys and OAuth subscription tokens (Claude/Codex) are kept server-side and refreshed there (`model-secret.ts`, `model-credential-refresh.ts`, `pi-credentials.ts`).
  - MCP OAuth tokens (`/mcp/oauth/callback`, docs/self-host-integrations.md).
  - Composio and Pipedream hold app OAuth on their side; Rakazo stores only the `COMPOSIO_API_KEY` and Pipedream keys in env [INFERENCE from the connector design].
- **LLM exposure, in three modes** (docs/bot-secrets.md):
  - (1) **HTTP secrets**: the model calls `secret_request {name,url,method}`. The backend injects a Bearer, header or Basic credential **outside the model**. The origin must match exactly, and redirects and private IPs are rejected. Echoed values (plain or encoded) are scrubbed from responses. "The model has no tool for reading these values." The docs admit a malicious service could transform and leak the value.
  - (2) **Command variables** (`auth.type:"command"`) are exported as env vars to the bot's shell. The docs state: **"The bot's shell reads this value… no secrecy from the bot."** They are redacted from output in plain, base64 and URL-encoded forms. Reserved names include `LD_*`, `RAKAZO_*` and `GIT_CONFIG_*`.
  - (3) Browser login and card fills (see section 1).
  - The user enters the value in a protected card; it is cleared from the input and omitted from messages, events and model input.
- **Scoping:**
  - Vaults belong to a member account or to a space.
  - A "Save to Vault" switch set to off gives a run-scoped login that is deleted when the run ends.
  - Space-level variables are shadowed by per-bot command variables.
  - Connected apps are shared across bots in a space (first pass).
- **Gates and audit:**
  - Approval modes are Ask, Auto (an LLM approval model) and Never ask, with Allow/Block lists.
  - A spending limit applies per day, week or month (docs/approvals.md).
  - The audit log is always on: `credential.created/changed/deleted/revealed/used`, approvals and auth events (docs/self-host-audit-log.md). The activity feed records **redacted** shell commands (docs/computer-runtime.md).
- **Telemetry:** Sentry (`SENTRY_DSN`) and OpenTelemetry are optional and operator-configured (docs/self-host-observability.md).
- **Cloud vs self-host:**
  - In the hosted cloud, Rakazo operates the keys, so it can technically decrypt [INFERENCE]. Self-hosters own `ENCRYPTION_KEY` and can use KMS.
- **Known weaknesses (stated in the docs):**
  - Team computers share an OS user, profiles and X11.
  - Losing or rotating `ENCRYPTION_KEY` strands ciphertext.
  - `RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP=1` sends credentials over plaintext HTTP.
  - "Always allow" on shell or browser lets outside text use them freely.

### 3. Crons / scheduling & triggers

- **Implementation:**
  - Routines are stored in Postgres.
  - Recurring schedules are computed with **croner** (`packages/core/src/cron.ts`, `resolveRoutineNextRunAt(cron, from, timezone)`).
  - **Graphile Worker** (a Postgres queue) runs scheduled and maintenance jobs that create runs (`WAKEUP_DRIVER=graphile`, `wakeup.ts`).
  - Runs then start by direct dispatch in-process, with an atomic lease and fence so each run executes exactly once across processes.
  - Workers rescan every 5 s for orphaned runs (dead process or expired lease) (docs/run-execution.md).
  - Embedded desktop installs use a "memory" job driver.
- **Syntax:**
  - UI presets: hourly, daily, weekdays, weekly, monthly, or a custom interval.
  - "Advanced…" takes a cron expression.
  - `@once` is used for one-shots (`ONCE_ROUTINE_CRON`, cron.ts l.16).
  - The timezone comes from Settings → General.
  - Natural-language requests in chat ("Remind me in 20 minutes", "Every weekday at 8am…") make **the bot create the routine itself** (docs/routines.md). Child bots use `create_child_routine`.
  - Routines can also be created in the UI or on mobile.
- **What a run is:**
  - Each run posts back **into the same chat thread** (docs/routines.md).
  - Catch-up keys on routine, prompt, thread and model (docs/run-execution.md). A routine can carry its own model and thinking level.
  - A run uses the bot's own computer and browser profile. **A bot uses its computer for one run at a time**: background runs queue behind it, and a user message _steers_ the active run (docs/run-execution.md).
- **Missed runs and overlap:**
  - **Late runs are never skipped.** One pending catch-up run is coalesced per routine (`routine-coalescing.ts`, `routine.coalesced` log).
  - If a run starts 15+ minutes late, the agent is told both the scheduled and the actual times, and history shows "Started 40m late" (`routine-lateness.ts`).
  - Retries use backoff (`routine-backoff.ts`). Run history, Test run, Stop, and the Active toggle are available (docs/routines.md).
  - An interactive run stuck for 30 s or more emits `run.queue_delayed`.
  - Model streams have no duration limit (docs/run-execution.md).
  - Model usage is tracked as credits (`model-credit-*.ts`). No per-routine budget was found [UNVERIFIED].
- **Approvals while away:**
  - Approval cards never block: the run pauses at a checkpoint, and the resume pins the same model and auth.
  - The user gets a notification (push or mobile).
  - Routine, webhook and email runs have reduced permissions. Purchases are refused, and watching a command always asks (docs/approvals.md, docs/computer-runtime.md).
  - Bots **never use the user's own computer from routines** (docs/computer.md).
- **Other triggers:**
  - Change-watch polling, 5 min to 1 day: files or folders, command output, or a connected-app tool (`routine-watch.ts`, `routine-http-watch`).
  - Webhook (URL plus key).
  - GitHub webhook.
  - Inbound email to the bot's address, restricted to "only me" or "anyone at my domain", with DKIM checks.
  - Slack message.
  - Bot-to-bot messages.
  - Release watch (`release-watch.ts`) (docs/routines.md).
- **Host off:**
  - The scheduler runs server-side, so it works when you're offline on cloud or a VPS. Missed ticks catch up when the server returns.
  - The desktop "This computer" Docker-free mode stops when the app quits (first pass), so routines catch up late at relaunch [INFERENCE].

### Sources (deep-dive)

- docs/computer.md, docs/computer-runtime.md, docs/bot-secrets.md, docs/content-encryption.md, docs/self-host-secrets.md, docs/routines.md, docs/run-execution.md, docs/approvals.md, docs/self-host-audit-log.md, docs/self-host-docker-computers.md, docs/self-host-observability.md, docs/self-host-integrations.md
- infra/sandboxes/computer/{Dockerfile, browser-policy.json, install-agent-browser.sh}
- packages/core/src/cron.ts; packages/adapters/src/{browser-tools.ts, browser-provider-factory.ts, computer-browser.ts, host-screen.ts, cua-host-screen.ts, bot-secrets.ts, aws-kms-key-provider.ts, infisical-secret-store.ts, model-secret.ts, routine-coalescing.ts, routine-lateness.ts, routine-backoff.ts, routine-watch.ts, release-watch.ts, wakeup.ts}

## A. Agent browser

- **Browser:** a real, headed **Chromium** inside the bot's Linux "computer" container. You can build with `BROWSER=chrome` (Google Chrome, amd64 only) or `brave` instead (infra/sandboxes/computer/Dockerfile:1,112-146).
- **Display:** **Xvfb**, the Fluxbox window manager, **x11vnc**, and **noVNC/websockify**. The viewer is embedded in the web, desktop, and mobile apps through a token-protected screen gateway (Dockerfile:54-63,215-217; docs/computer-runtime.md).
- **Driver:** the built-in tools `browser_navigate`, `browser_snapshot`, and `browser_act` run through a helper that drives that visible Chromium via **Vercel's `agent-browser` over CDP**. The helper binary is pinned and sha256-checked (`install-agent-browser.sh`). CDP binds only to the container's loopback interface.
  - Generic desktop tools (`computer_observe`/`computer_act`, screenshots) are also available.
  - These are built-in tools, not MCP (docs/computer-runtime.md:57-59; packages/adapters/src/browser-tools.ts, page-browser-*.ts).
- **Where it runs:**
  - Server side, in Docker on the self-host machine, or on E2B, Daytona, Boat, or the other sandbox providers.
  - On hosted, a vendor cloud computer.
  - The desktop app can also let a bot use the user's own computer (`host-computer-*.ts`, `cua-host-screen.ts`). Whether that drives the user's actual Chrome profile is [UNVERIFIED].
- **Watch and take over:** yes. "Take control" grants the user an exclusive control lease. The bot calls `request_takeover` ("Needs you") for CAPTCHAs and SMS codes (docs/computer.md:15-24; docs/computer-runtime.md:63).
- **Profiles:**
  - Each bot gets a persistent Chrome profile keyed to its identity, under `$RAKAZO_HOME/.browser-profiles/`. Profiles are never cloned or merged between bots, and they are included in workspace checkpoint/export (docs/computer-runtime.md:42,113-125; `rakazo-browser:20-26`).
  - However, docs/computer.md says that on a shared "Team" computer "sites you sign in to are carried over to the other bots". The runtime doc states Team bots share the OS user and browser profiles and that the container is the only security boundary. Use a "Private" computer for isolation.
- **Logging in as the user:** this uses a separate profile, not the user's own Chrome. The user signs in via takeover, or the bot saves a login to the vault. `page_secrets.py` types saved logins and cards over CDP, so they never pass through agent-browser.
  - Chrome policy disables the password manager and autofill (`browser-policy.json`).
  - Importing cookies from the user's Chrome: none found [UNVERIFIED].
- **Anti-bot / stealth:** none found. CAPTCHAs are handed to the human via takeover [INFERENCE from docs/computer.md].

## B. Credentials and secrets

- **Server encryption:**
  - All server secrets are encrypted with the deployment's `ENCRYPTION_KEY` (64 hex chars, generated by the installer; docs/self-host-secrets.md).
  - Content encryption at rest is envelope encryption. Each space has a random 256-bit data key, wrapped with AES-256-GCM by master keys from `ENCRYPTION_MASTER_KEYS`, or derived from `ENCRYPTION_KEY`. Values use AES-256-GCM with a fresh IV and authenticated data bound to the record (docs/content-encryption.md:43-62).
  - Optional backends: AWS KMS key provider (`aws-kms-key-provider.ts`) and Infisical as the secret store (`infisical-secret-store.ts`, docs/infisical-secrets.md).
- **Vault:**
  - User credentials (API keys, logins, cards) go in Postgres `vault_credentials`. They are encrypted with AES-256-GCM under the content keys, or under `ENCRYPTION_KEY` (docs/bot-secrets.md).
  - MCP OAuth clients and grants are stored encrypted (docs/self-host-integrations.md).
  - Model OAuth tokens: `pi-credentials.ts` keeps refreshes in memory and "published back for encryption" into the database.
- **Brokered, not exposed:** HTTP credentials are injected by the backend at call time.
  - The bot calls `secret_request {name,url,method}`, and the backend decrypts and adds the Bearer, header, or Basic auth.
  - The origin must match exactly, redirects are rejected, and there are SSRF checks.
  - Responses are capped at 30 s and 1 MB, echoes of the secret are redacted, and "the model has no tool for reading these values".
  - Values are typed into a protected UI card and omitted from messages, events, and model input (docs/bot-secrets.md).
  - Exception: **command variables** (`auth: command`) are deliberately exported as environment variables into the bot's shell, so the sandbox does see them.
- **Subscription tokens:**
  - The Claude OAuth token is held by the server-side model layer (pi-ai). No `CLAUDE_CODE_OAUTH_TOKEN` or `~/.codex/auth.json` is mounted into the sandbox: grep found these only in agent-import code, not in the sandbox [INFERENCE].
  - Separately, a "Personal CLI access" provider spawns a local `claude` CLI (`cli-models/claude-code/cli.ts:10,133`). It is refused on servers that bill for model usage or have more than one account, so the hosted service cannot use it (`cli-models/personal-access.ts`).
- **Third parties:**
  - With the app catalog, Gmail and other OAuth grants are held by **Composio** or **Pipedream**, not by Rakazo [INFERENCE from the connector design; docs/self-host-integrations.md:137-139].
  - Hosted (app.rakazo.com): the vendor holds the encryption keys and data.
- **Defences:**
  - Approval modes: Ask, Auto (an LLM approval model checks each action against the request), and Never. Allow and Block lists apply.
  - Permissions are reduced after reading outside content, after a pause, or in routine, webhook, chat-app, or email runs. Mutations are checked even when "Always allow" applies, and **purchases are refused** in runs started by outside text (docs/approvals.md; docs/routines.md note).
  - Secret redaction in run details and injection eval scenarios (docs/context-and-evals-tasks.md:336,360).
  - The sandbox supervisor holds the Docker socket, behind `SANDBOX_SUPERVISOR_TOKEN`. Computer egress can be restricted.
  - Audit log with 365-day default retention, export, and SIEM forwarding (docs/self-host-audit-log.md).
  - Secret scoping: a credential belongs to the user who saved it, at most 100 per bot. Team bots share one computer, so files and shell are not isolated between them.

## C. Crons / scheduling

- **What a routine is:** a prompt plus triggers (docs/routines.md). Trigger types:
  - Schedule: presets, a custom interval, or a cron expression under "Advanced". Uses the user's timezone from Settings → General.
  - "When something changes" polling, every 5 minutes to 1 day, watching files, a command's output, or a connected-app tool.
  - Webhook (URL plus key).
  - GitHub webhook.
  - Email to the bot's own address, with DKIM-verified sender filtering.
  - Slack message.
  - One-shot reminders ("in 20 minutes").
- **Agent-created schedules:** yes. "Ask for one in chat" makes the bot create the routine (`schedule-tools.ts`).
- **Engine:**
  - Firing is Postgres-backed via **graphile-worker 0.18** (packages/adapters/package.json:61; `WAKEUP_DRIVER=graphile`, docs/self-host-configuration.md:45).
  - Cron parsing uses **croner** (packages/core/package.json:97). [INFERENCE: croner computes next occurrences and graphile jobs fire them.]
  - All state lives in Postgres, including the `graphile_worker` tables and the routine and run rows.
  - Run in the separate `worker` app.
- **Missed runs:**
  - Catch-up is coalesced: at most one unstarted catch-up per routine, and redundant timer occurrences are dropped (`routine-coalescing.ts`).
  - Late runs (for example, "the host was offline") are flagged with the original due occurrence so the prompt can adjust (`routine-lateness.ts`).
  - Account and quota failures back the schedule off (`routine-backoff.ts`).
  - A job reconciler and a stuck-work sweeper exist (`job-reconciler.ts`, `stuck-work.ts`).
- **Controls:** test run, pause, Stop, run history (web and mobile), a per-routine model for cheaper runs, and the routine's own approval policy. Concurrency: `GRAPHILE_WORKER_CONCURRENCY`, default 4 (docs/self-host-configuration.md:169). On hosted, computer-hours caps apply.
- **Laptop-off:** routines keep firing only when the API, worker, and Postgres run on an always-on host (VPS, Railway, or hosted cloud). The macOS Docker-free desktop stack stops when the app quits, while Docker-based desktop stacks keep running until stopped (docs/self-host.md).

## D. Stack scope clarification

- **Verified for self-host/OSS:** everything in "Tech stack" above was read from the public repo at commit #4577.
- **Hosted cloud:**
  - Evidence that it runs the **same codebase**:
    - `infra/compose/deploy-main.sh` deploys "from origin/main", pulling the CI-published image `<RAKAZO_DEPLOY_IMAGE>:sha-<commit>` to `/srv/rakazo` on a Docker host. It does this via a CI forced-command SSH deploy user.
    - Production ops files (`Caddyfile.prod`, `harden-host.sh`, `backup-prod.sh`, `pitr.sh`, systemd timers) are in the public repo.
    - Billing code is open (`stripe-billing.ts`).
    - `personal-access.ts` comments refer to "the hosted service".
  - Live headers on app.rakazo.com: `server: cloudflare`, `via: 1.1 Caddy` (curl, 2026-11-13). This is consistent with the Compose plus Caddy production path behind Cloudflare [INFERENCE].
  - Unknowns:
    - VM provider (Hetzner, AWS, ...) and which sandbox provider the hosted computers use (E2B, Boat, ...): [UNVERIFIED]. The pricing page only says "EU hosting".
    - Whether private extra services exist: [UNVERIFIED]; nothing found.
  - The privacy page lists model and voice providers, but the subprocessor list shown in the summary does not name the hosting provider.
- **Other deploy configs in the repo:**
  - Railway template (self-host; runs agent computers on Railway).
  - Fly.io, used only for PR previews (`infra/preview/README.md`).

## E. Sandbox / agent computer: what it is used for

### 1. What the computer is

- **Form:** "Every bot has a real computer with a browser, a terminal, files and a desktop, so it can do work that needs more than a chat" (docs/computer.md:1-4). On self-host this is a Debian Docker container (`rakazo/computer`). It can also run on E2B, Daytona, Boat, Kubernetes, or the other providers, or on a vendor cloud computer when hosted.
- **Granularity:** by default there is **one Team Computer per workspace (space)**. Each bot gets its own folder `bots/<id>/`, its own X display, and its own Chrome profile, with a `shared/` folder for common work. A bot can instead use a **Private Computer** (docs/computer-runtime.md:40-42; docs/computer.md "Team or Private").
- **Lifecycle:**
  - It is lazy and sleep/wake: it "starts when a bot needs it and goes to sleep when idle", and opening the view wakes it (docs/computer.md:8-10). Hosted pricing counts hours only while it is in use (/pricing).
  - The workspace home persists and is checkpointed and exported. System packages outside the workspace are not portable (docs/computer-runtime.md:119-182).
  - User actions: Stop, Update, Recover, and Reset to the last saved workspace (docs/computer.md).
- **Installed software** (infra/sandboxes/computer/Dockerfile):
  - Desktop: Xvfb, Fluxbox, xterm, xdotool, ImageMagick, noVNC.
  - Browser: Chromium (or Chrome/Brave) plus `agent-browser`.
  - Tools: python3 and `uv`/`uvx`, python3-openpyxl, git, jq, openssh-client, curl, unzip, ripgrep, fd, poppler-utils, pandoc.
  - Fonts, including CJK, Thai, and emoji.
  - Node in the image: [UNVERIFIED].
- **What the agent can do there:**
  - Shell commands and file read/write: `shell` and the workspace file tools (`computer-tools.ts`, `workspace-file-tools.ts`).
  - Browser through `browser_*`, and GUI computer-use through `computer_observe`/`computer_act`, `open_path`, and `launch_app` (docs/computer-runtime.md:59-61).
  - Installing packages and git clone/push [INFERENCE: shell plus git and ssh are present].
- **Role in the agent loop:** the computer is a **tool target, not where the loop runs**. The loop (pi-agent-core) runs in the API/worker. The computer is only provisioned when a tool needs it (`executor-lazy-computer.test.ts`), and the pricing page says most work doesn't need it.
- **Alternative target:** in the desktop app, "Let bots use this computer" lets bots run commands and drive apps on the user's real Mac or Windows machine. Each app needs first-use approval, and it is never used from routines (docs/computer.md "Use your own computer").

### 2. Use cases the project shows

1. **Morning briefing:** a weekday digest of calendar, inbox, weather, and news (packages/core/src/bot-templates.ts:13-60). Uses the API and connectors; **no computer needed** [INFERENCE].
2. **Inbox triage** template (bot-templates.ts:70-114), via the Gmail connector. Website template: "Inbox Manager: Sort email and draft replies". No computer needed.
3. **PR reviewer:** reviews PRs waiting on the user with cron `0 9 * * 1-5`, quoting file and line, and "never post a review ... without the user's go-ahead" (bot-templates.ts:124-170). Works via the GitHub connector or a pasted link. It _may_ clone the repo on the computer [INFERENCE].
4. **Topic watch / weekly digest** (bot-templates.ts:176-216). Uses web search and fetch; no computer needed.
5. **Coding Agent:** "Make code changes on your computer" (rakazo.com templates). **Needs a computer**: shell, git, or the user's own machine via the desktop app. It can also hand work to cloud coding agents (Cursor, T3 Code; `cloud-agent-*.ts`).
6. **Teach a task by showing it:** for example "Export this week's list from the CRM and drop it in the shared folder". The user records the task on the bot's screen and it becomes a skill (docs/skills.md:34-47). **Needs the GUI computer.**
7. **Marketplace deal hunting:** a site testimonial says the bot "find[s] cheap servers and computer parts on ebay and all other marketplaces and send[s] me everything" (rakazo.com). Uses the browser, or web fetch [INFERENCE].
8. **Pages:** "Make me a page that tracks our open deals", or "Turn this research into a page I can share". This is a live dashboard or report card that a routine keeps updated, with a public link and PDF export (docs/pages.md). Hosted by Rakazo; no computer needed [INFERENCE].
9. **Watch-for-changes routines** on "files or folders on the computer, a command's output" (docs/routines.md). Watching files or command output **needs the computer**.
10. **Remaining site templates:** Sales Outbound (research prospects, draft follow-ups), Talent Scout, Expense Manager (match receipts to payments), Account Manager, Paid Media (ad spend reports), and Chief of Staff (coordinates the other bots) (rakazo.com). These are mostly connector or browser work.
11. **Logins, CAPTCHAs, and purchases:** the bot hands the screen to the user for a CAPTCHA or SMS code (docs/computer.md:15-24). It can type saved cards and logins via `page_secrets.py`, with purchase gates (`purchase-gate.ts`).
12. **Output files:** files the bot produces go back to the chat as attachments and appear under Artifacts. Examples include spreadsheets via openpyxl and PDFs or docs via pandoc and poppler [INFERENCE from the image contents].

### 3. End-to-end flows

**Flow 1: teach, then schedule, then run unattended** (docs/skills.md:34-47 plus docs/routines.md; joining the steps is [INFERENCE]).

1. The user opens **Agent computer**, chooses **Teach a task**, and describes the result ("Export this week's list from the CRM...").
2. The user clicks **Start recording** and does the task in the bot's Chromium, typing passwords with **Protected input**.
3. The user clicks **Stop teaching**. The bot posts a **Draft skill** card with the steps, the checks, and when to ask first.
4. The user edits and saves it, presses **Test**, then **Add to routine** (for example weekdays at 8am, in the user's timezone).
5. At the scheduled time, with the user absent, the graphile-worker job fires and the computer wakes.
   - The bot replays the skill in the browser and saves the file into `shared/`.
   - The run reports in the same chat and in Run history. If an action falls under the approval mode, an approval card waits there and the user gets a notification.

**Flow 2: takeover for a login or CAPTCHA** (docs/computer.md:15-24; docs/computer-runtime.md:63).

1. The bot is working on a site and hits a CAPTCHA or SMS code. It calls `request_takeover`, the header shows **Needs you**, and the user gets a push notification.
2. The user opens the computer (web, desktop, or mobile noVNC view). They take an exclusive control lease, solve the step, then press **I'm done** (or **Skip**).
3. The bot resumes. The login cookies persist in that bot's Chrome profile. Optionally the user asks the bot to "save the login", which stores it in the encrypted vault (docs/bot-secrets.md).

**Flow 3: PR review with approval** (bot-templates.ts:124-170 plus docs/approvals.md).

1. The routine fires at 09:00 on weekdays. The bot lists PRs that request the user's review and reads the diffs (GitHub connector).
2. It posts at most five points per PR with a suggested verdict.
3. The user replies "post it". Posting a review is a mutating action, so an approval card appears (**Allow once / Always allow / Deny**) unless the mode allows it.

### 4. File and data flow

- **In:**
  - Chat **Attach file** for files and images (docs/bots-and-chats.md:35).
  - Connectors and MCP.
  - git and curl from inside the computer.
  - Host folder mounts on self-host: `SANDBOX_COMPUTER_MOUNTS` (for example `/srv/team-docs:/mnt/team-docs`), read-only unless `rw` (docs/self-host-docker-computers.md:159-164).
  - Inbound email to the bot's address.
- **Out:**
  - Files sent to chat, which also appear under **Artifacts** in the account menu (docs/computer.md).
  - Pages with public share links.
  - Messages in Slack, Telegram, and other channels.
  - Bot homes can be kept in S3-compatible object storage, always encrypted (docs/content-encryption.md:15).
- **User's local files:**
  - Not reachable from cloud or Docker computers, except through explicit mounts.
  - Fully reachable when "Let bots use this computer" is enabled in the desktop app ("can read your files and run programs as you").
- **Egress:** `SANDBOX_COMPUTER_EGRESS=restricted` installs an iptables ruleset (`infra/compose/restrict-computer-egress.sh`). It gives public internet (browsing, DNS, apt, git) but blocks LAN, host, and metadata addresses. The default is `auto`; desktop and `pnpm dev` stacks default to open (docs/self-host-docker-computers.md:35-75).

### 5. Limits and caveats

- **Self-host Docker defaults:** `RAKAZO_COMPUTER_MEMORY=2g`, `RAKAZO_COMPUTER_CPUS=2`, `PIDS_LIMIT=2048`. Each can be set to unlimited. `SANDBOX_TEAM_SCREEN_LIMIT` caps concurrent desktops (docs/self-host-docker-computers.md:20-29).
- **Hosted:**

  | Plan     | Price | Computer hours/mo | Machine         |
  | -------- | ----- | ----------------- | --------------- |
  | Standard | $15   | 25 h              | 4 vCPU / 8 GB   |
  | Pro      | $49   | 100 h             | 8 vCPU / 16 GB  |
  | Max      | $99   | 200 h             | 16 vCPU / 32 GB |

  Credits plans start at 20 h. There are no overage charges and at most 5 computers run at once (/pricing; FAQ).

- **No GPU:** none mentioned for computers [UNVERIFIED]. Local models run outside the computer via an OpenAI-compatible URL.
- **Isolation gap:** Team bots share the OS user, files, browser profiles, and X11 access. "The computer container is the security boundary"; use Private computers or separate spaces (docs/computer-runtime.md:57).
- **Persistence:** only the workspace home persists. apt-installed system packages are lost on Update or Recover (docs/computer-runtime.md:182).
- **Not everywhere:** Teach-a-task is web and desktop only. Page-browser tools are limited to providers that implement `pageBrowser`; others fall back to desktop tools (docs/computer-runtime.md:59).

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

**F1. Verdict.**

- **Hosted (app.rakazo.com "Your model" plan): Yes.** The decisive reason: the pricing page lists "Claude, ChatGPT, or any API key" on the hosted Standard/Pro/Max plans. The ChatGPT login is a server-side device-code OAuth grant, stored and refreshed in Rakazo's cloud, so the laptop plays no part after setup (/pricing; `packages/adapters/src/pi-oauth.ts:36-42`).
  - Caveat: no doc or test explicitly shows a _routine_ on ChatGPT OAuth. I found no code that restricts it to interactive turns [INFERENCE].
- **Self-hosted on a VPS or Railway: Yes**, by the same mechanism, with the always-on host being yours.
- **Desktop-local stack: No.** The macOS Docker-free stack "stops when the desktop app quits" (docs/self-host.md).

**F2. The ChatGPT subscription.**

- **Token transfer:** the user clicks Settings → Models → OpenAI Codex → **Sign in with ChatGPT** in the web, desktop, or mobile app. This starts a **device-code** flow (`mode: "device-code"`, hint "ChatGPT Plus/Pro", billing text "Uses your OpenAI subscription. Rakazo does not pay.", pi-oauth.ts:36-42; device-code handling at :657-700).
  - The cloud server receives its own token pair.
  - It does not upload `~/.codex/auth.json`, paste tokens, or relay through a laptop CLI.
  - It is an independent grant from the laptop's Codex login, so the two don't conflict [INFERENCE].
- **Storage:** the tokens are encrypted in Rakazo's Postgres (AES-256-GCM under `ENCRYPTION_KEY` or the space keys; docs/content-encryption.md) and are held only by the API/worker. The bot's computer never receives them (section B).
- **Unattended refresh:** `model-credential-refresh.ts` refreshes under a database lock because "Providers rotate refresh tokens".
  - A terminal 4xx or `invalid_grant` failure, or an account switch detected via the JWT `chatgpt_account_id`, **retires** the credential and leaves a reconnect marker (pi-oauth.ts:143-221). From then on every run fails until the user signs in again.
- **Who calls the model:** the vendor's cloud worker calls OpenAI with the user's token, in process via `@earendil-works/pi-ai` provider `openai-codex`, from Rakazo's server IP. The code even forwards OpenAI's `chatgpt_compute_residency` JWT claim (pi-oauth.ts:457), which suggests it is built for this path.
  - Rakazo's docs only say the user needs "an eligible plan with available Codex usage" (docs/model-subscriptions.md).
  - Whether OpenAI's terms permit this from a cloud IP or unattended: **[UNVERIFIED]**.
- **Plan restrictions:** no restriction found for ChatGPT on hosted. The only subscription block is for the spawned `claude` CLI, which is refused on billing or multi-account servers (`cli-models/personal-access.ts`). Claude OAuth is discouraged by the docs.
  - Vendor credits are an **alternative plan**, not forced: "Rakazo credits", from $20/mo, billed at provider price (/pricing).
  - When the Codex allowance runs out, an optional **fallback model** (an API key or credits) takes over (docs/models.md). Without one, `routine-backoff.ts` defers the routine to the provider's reset time, at most one day later.

**F3. Setup UX (hosted).**

1. Sign up at app.rakazo.com and choose Standard at $15/mo ($12/mo yearly). There is a 7-day trial with 10 computer-hours (/pricing).
2. Settings → Models → Sign in with ChatGPT, then enter the device code at OpenAI.
3. Settings → General → timezone (docs/routines.md).
4. Create or pick a bot. In chat, say: "Every night at 03:00 log in to X, collect …, save as CSV and send it to me". The bot creates the routine via `schedule-tools.ts`.
   - Alternatively, use Agent computer → Routines → Create Routine, with presets or a cron field under **Advanced…**.
5. **Human step, site login:** open Agent computer → **Take control**, sign in to X (including 2FA), then **Release control**. The cookies persist in that bot's Chrome profile (docs/computer.md; docs/computer-runtime.md:42).
   - Optionally ask the bot to "save the login" to the vault (docs/bot-secrets.md), or use **Teach a task** to record the steps (docs/skills.md:34-47).
6. **Test run** from the routine (docs/routines.md).
7. **Human step, approvals:** pick **Auto** (needs an Approval model) or **Always allow** for the tools used. In **Ask** mode an action that "changes something" posts a card and waits (docs/approvals.md). Whether a pure browse-plus-workspace-file run triggers a card is [UNVERIFIED].

**F4. Execution at 03:00.**

- **Trigger:** graphile-worker jobs in Postgres, with croner computing cron occurrences, run in the cloud `worker` (packages/adapters/package.json:61; packages/core/package.json:97).
  - Missed ticks are coalesced into one late-flagged catch-up (`routine-coalescing.ts`, `routine-lateness.ts`).
- **Computer:** lazily provisioned or woken from sleep (docs/computer.md:8-10). The desktop and Chromium start on the first graphical tool (docs/computer-runtime.md:46).
- **Scraping:**
  - JS-rendered or logged-in pages go through the built-in `browser_navigate`/`browser_snapshot`/`browser_act`, which drive a real headed Chromium via agent-browser over CDP (docs/computer-runtime.md:59).
  - Simple public pages can use `web_fetch` (Readability extraction, no computer needed; docs/self-host-integrations.md).
- **CSV creation:** `shell` running python3 with `uv` or `openpyxl` in the image, or the workspace file tools (infra/sandboxes/computer/Dockerfile). It is saved in the bot's persistent workspace home (`bots/<id>/` or `shared/` on the Team computer), which is checkpointed (docs/computer-runtime.md:119-125).
- **Cookies** persist between nights in the per-bot Chrome profile.
- **Failures:**
  - The run gets one retry and the failure notice is held (`executor-routine-failure.test.ts:457`).
  - The owner is notified if the routine is set to notify (:311, :353).
  - Run history is kept (docs/routines.md).
  - CAPTCHA, 2FA, or an expired login means the bot calls `request_takeover` and the run waits for a human ("Needs you", docs/computer.md:15-24).
  - Token retired or quota exhausted: see F2 (fallback or back-off).

**F5. Getting the CSV out.**

- **Chat attachment:** the routine "reports each run back in the same chat" (docs/routines.md). Files the bot sends also appear under **Artifacts** for download on web, desktop, or mobile (docs/computer.md).
- **Slack or Teams message:** available on hosted. Telegram and WhatsApp are **self-host only** (rakazo.com).
- **Email:** via the bot email tools (`run-tools-email.ts`) [UNVERIFIED for attachments].
- **Google Drive or Sheets:** via a Composio/Pipedream app connection [INFERENCE].
- **Git push** from the computer's shell [INFERENCE].
- **Page:** a public share link displaying the data (docs/pages.md).
- **No automatic sync back to the laptop.** `SANDBOX_COMPUTER_MOUNTS` is self-host only and mounts the host into the computer, not onto the laptop.

**F6. Gaps and risks.**

- **Cost (hosted):** $15/mo including 25 computer-hours. The meter counts only while the computer is in use and pauses when idle, with no overage charges (/pricing; FAQ).
  - A nightly run of a few minutes is roughly 1-3 h/month [INFERENCE: no per-run figure is published].
  - A spent allowance is a back-off condition (`routine-backoff.ts`).
  - Model usage counts against the ChatGPT plan, not Rakazo.
- **Self-host cost:** free software plus the VPS cost. Default Docker computers are 2 GB RAM and 2 CPU (docs/self-host-docker-computers.md:20-21).
- **ToS:** the subscription is used from the vendor's cloud IP, unattended. OpenAI's position is not stated in Rakazo's docs [UNVERIFIED].
- **Bot-blocking:** no stealth, proxies, or CAPTCHA solving were found. A bot wall at 03:00 stalls the run until the user takes over in the morning.
- **Silent failure risks:**
  - An Ask-mode approval card left waiting.
  - A retired OAuth credential, which needs a re-login.
  - An exhausted Codex quota with no fallback.
  - Notifications switched off.
- **Isolation:** on the default Team computer, other bots in the space share the browser profiles and files. Use a **Private** computer for the logged-in scrape (docs/computer.md).
- **Persistence:** packages installed with apt are lost on Update or Recover; keep tools in the workspace via `uv` (docs/computer-runtime.md:182).
