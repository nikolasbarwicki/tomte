# Nuphos research (2026-11-13)

## What it is

- A team workspace for coding agents, marketed as "The open source Grok Bot alternative" (nuphos.ai title). It runs the user's Claude Code, Codex, OpenCode, Grok Build or Antigravity as always-on "Bots". Teammates can join a live session together, and the same bot can sit in Slack, Discord or Lark. The product leans heavily toward DevOps: it has GUIs for Kubernetes, Grafana, GitHub and Linear, plus cloud-account connectors (README; docs.nuphos.ai/introduction).
- Repo: https://github.com/nuphos/nuphos (monorepo). License: **Apache-2.0** (`LICENSE`). GitHub's API reports `NOASSERTION` because of the extra `NOTICE` and `TRADEMARK.md` files. The "Nuphos" trademark belongs to **Zeabur Inc.** (`NOTICE`: "Copyright 2026 Zeabur Inc.").
- Repo stats (gh api, 2026-11-13): 548 stars; created 2026-10-01; last push 2026-11-13; about 1,804 commits. Backend version is `0.130.0` and runtime is `0.1.56`.
- Clients: macOS/Windows/Linux desktop, iOS app (id6812533633), Android (`ai.nuphos.android`) and a Rust CLI (`curl -fsSL https://nuphos.ai/install | sh`).

## Infra / self-hosting / laptop-off behavior

- **Architecture:** the backend (Bun/Hono) never runs the agent itself. It opens an ACP (Agent Client Protocol) session against a **runtime**, which is a long-lived container holding one agent CLI. The OpenAB gateway (vendored from openabdev/openab) supervises that CLI (`apps/runtime/README.md`).
- **Three places a runtime can live:** (a) "this Mac" (local), (b) a remote machine you own, or (c) a Nuphos Cloud managed computer. You can move a conversation between them and keep its context ("Runtime switcher" on the homepage; README "Run it where you want").
- **Laptop off:** "On a cloud computer or a server you keep running, its turn continues after you close your laptop" (README). A local runtime stops with the laptop. That is my [INFERENCE] from the docs saying "A remote or cloud runtime keeps running independently of your laptop" (docs/introduction).
- **Triggers:** schedules (cron, parsed with `cron-parser`, UTC by default, see `apps/backend/src/lib/cron.ts`) and webhooks start agent turns from the backend (`routes/agent-triggers.ts`; docs/agent/triggers). Slack and Discord replies are also handled server-side.
- **Background jobs:** the hosted backend uses Redis/BullMQ. The compose self-host has no Redis and runs "single-replica in-memory mode" (`deploy/compose/README.md`).
- **Managed cloud computers:**
  - In Kubernetes, the backend provisions per-team "OpenAB sandboxes" (Deployment + Service + Secret) in a dedicated `openab-runtimes` namespace with a ResourceQuota (`deploy/openab-runtime-provisioner.yaml`).
  - The backend also depends on `@insforge/instabox-sdk`, and docs mention "bring your own instabox account" for cloud computers. Whether instabox VMs are the default Nuphos Cloud computer is [UNVERIFIED].
- **Self-host options:**
  - Docker Compose: `deploy/compose`, run `./init-env.sh` then `docker compose up`. It brings up mongo:8 (replica set), rustfs (S3-compatible storage), the backend and `ghcr.io/nuphos/runtime`.
  - Helm chart: `deploy/helm`.
  - Railway CLI guide: `deploy/railway`.
  - You pair a runtime from its console using a single-use pairing code (10-minute expiry). Internet connections must use `wss://` (runtime README).
  - Limits: one team per self-hosted deployment. Not available when self-hosting: managed runtime provisioning, backups, Google sign-in, and custom endpoints on Android (README).
- **Data, secrets and memory:**
  - MongoDB stores accounts, sessions, transcripts and memory; S3 stores files.
  - Model logins stay inside the runtime container, e.g. `/home/node/.claude/.credentials.json` and `/home/node/.codex/auth.json` (runtime README; docs: "A runtime's sign-in stays on its computer").
  - Integration secrets are encrypted at rest with a BYOK key (`config/byos-integrations.ts`).
  - Agents get short-lived tokens scoped to actor, team and conversation. Cloud access is federated: AWS assume-role, GCP impersonation, OIDC for Azure, Tencent, Aliyun and others (docs/agent/runtime; README "Connected accounts").
- **Isolation:**
  - Each runtime is a container. Per-session `HOME` (`NUPHOS_SESSION_HOME`) separates CLI credentials.
  - In compose, the runtime is kept off the Mongo network.
  - Auto Mode / Full Access permission modes plus approvals gate high-risk cloud changes (docs/security/auto-mode).
  - I found no gVisor or Firecracker in the repo files I checked.

## Claude / Codex subscription use

- **Yes, first-class for both; this is the headline feature.** The homepage says: "Bring Claude Code or Codex … Sign in with your account, with no extra model charge on top."
- **Claude:**
  - The image bundles `@agentclientprotocol/claude-agent-acp` 0.74.0 with the Claude Code CLI from Agent SDK 0.3.322.
  - Login runs `claude auth login` inside the container (`docker exec -it nuphos-runtime claude auth login`), or from the app through `claude-login.mjs`.
  - Alternatively, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (runtime README; `image/runtime-start.sh:171`).
- **Codex:** `@openai/codex` 0.167.0 + `@agentclientprotocol/codex-acp` 1.1.4. Login is `codex login --device-auth` (driven by `codex-login.mjs`), or seed it from a mounted secret with `nuphos-seed-codex-auth`.
- **Other runtimes:**
  - Grok Build: `grok login --device-auth`.
  - Google Antigravity: `agy acp --login`, Google OAuth.
  - OpenCode: free OpenCode Zen models, or any OpenCode provider via API key or browser login, including Amazon Bedrock keys.
- **ToS:** the runtime README notes that Claude Code and the Agent SDK "are distributed under Anthropic's commercial terms", and that proprietary CLIs are downloaded "under the vendors' terms".
  - I found no explicit ban-risk warning.
  - Billing docs warn that sharing a computer can share its runtime sign-in (docs/billing). [INFERENCE] One person's Claude login could then be used by a whole team, which is relevant to consumer-plan ToS.

## MCPs / apps / integrations

- **MCP server:** Nuphos exposes itself at `https://api.nuphos.ai/mcp` (Streamable HTTP, JSON mode, OAuth). Tools include `nuphos_ask` and `nuphos_check`, so Claude Code or Codex can delegate work to Nuphos agents (`apps/backend/src/routes/mcp.ts`; docs/connectors/mcp).
- **MCP client:** the runtime patches the adapters to bridge HTTP MCP servers. `mcp-http-bridge.mjs` relays stdio MCP servers to a bearer-authenticated HTTP endpoint (runtime README). There is no MCP marketplace. Memory is built in and needs no MCP server.
- **Skills:** team or personal skills that are created/imported in the app, synced to runtimes (`nuphos-sync-skills`) and shared team-wide. There are about 55 built-in skills in `apps/backend/src/lib/agent/builtin-skills/skills/`, for example aws, gcloud, kubectl, helm, github, gitlab, linear, jira, notion, sentry, grafana, posthog, trello, google-workspace, tailscale and grok-bot-export.
- **Gmail / Drive:**
  - The _team admin registers its own Google OAuth client_ (docs/connectors/google-workspace).
  - Each member connects a "Personal Credential" in Settings.
  - The agent runs `setup-credentials.sh` to fetch a short-lived (~1h) access token and calls the Gmail/Drive REST APIs directly with curl.
  - Only the session owner can use their token (403 `personal_credential_owner_only` otherwise).
  - Composio is used as a backend for some connectors: `lib/composio.ts`; the google-workspace and trello skills include `composio.sh`.
  - There is no Google Calendar connector in the docs index.
- **Connectors (docs index):**
  - Cloud: AWS, GCP, Azure, Tencent, Alibaba, Volcengine, Huawei, Cloudflare, Linode, Hetzner, Zeabur, on-prem Kubernetes (outbound relay), Tailscale.
  - Work tools: GitHub, GitLab, Linear, Jira, Asana, Notion.
  - Observability: Grafana, Better Stack, Uptime Kuma, Sentry, SonarQube, PostHog.
  - Data, email and compliance: MongoDB, Upstash, Plaud, Resend, Vanta, Secureframe.
- **Desktop extras:** in-app browser, remote desktops, dashboards and design canvas (docs/desktop).
- **Chat channels:** the desktop/iOS/Android/CLI clients, **Slack**, **Discord** and **Lark/Feishu** (`routes/slack*`, `discord*`, `lark*`). I found no Telegram, WhatsApp or iMessage channel.
- **Migration:** there are guides for moving from Conductor and Conductor Cloud.

## Monetization

- Nuphos Cloud bills managed-computer capacity monthly through Stripe (docs/billing.md, seen 2026-11-13):
  - **4 vCPU: $20/mo**
  - **12 vCPU: $50/mo**
  - **24 vCPU: $100/mo**
- The limit is the sum of vCPUs across a team's running managed computers. Paused computers don't count. **There is no model/inference charge**: you use your own subscription.
- If you bring your own instabox account, instabox bills it.
- Your own machines don't count toward the plan. Self-hosting is free under Apache-2.0, with trademark restrictions (`TRADEMARK.md`).
- The docs say older Free, Dev, Team, Business and Scale workspace plans are obsolete. https://nuphos.ai/pricing returns 404. I found no explicit free tier for cloud computers [UNVERIFIED].

## Differentiator

- **Multiplayer sessions:** several people steer the same live agent and see the same tool calls; sessions can be shared like a Notion page. Team-shared skills, connectors and memory come with it.
- **DevOps/infra focus:** native Kubernetes, Grafana, cloud and DB GUIs beside the chat, with keyless federated cloud identity (OIDC / assume-role) and approval gates. Testimonials are all infra migrations.
- **Runtime portability:** an ACP plus OpenAB architecture with five agent CLIs (Claude Code, Codex, OpenCode, Grok Build, Antigravity). One conversation can move between laptop, your server and cloud.
- **Company and team:** backed by Zeabur Inc. Very high commit velocity (about 1,800 commits in 6 weeks). Large test suite (`*.test.ts` throughout) and CI.
- **Weaknesses:**
  - Very new (repo created 2026-10-01) and moving fast; the docs warn "Features evolve quickly".
  - Self-hosting is limited to one team and lacks Google sign-in and managed provisioning.
  - Gmail requires an admin-created Google OAuth client.
  - No Telegram or WhatsApp; it is aimed at teams and DevOps rather than personal-assistant use.
  - Shared Claude logins may conflict with consumer-plan ToS [INFERENCE].

## Tech stack

- **Backend** (`apps/backend/package.json`):
  - TypeScript on **Bun** + **Hono**, zod and OpenTelemetry.
  - Storage: **MongoDB** 8, **Redis (ioredis) + BullMQ** queues, S3 (AWS SDK; RustFS when self-hosted).
  - Large AWS, GCP and Alibaba SDK dependencies; Stripe.
- **Desktop** (`apps/desktop`): **Electron 44 + Vite 8 + React 19**, built with pnpm 10 on Node 22.
- **Mobile:** iOS in **SwiftUI**; Android in **Jetpack Compose**.
- **CLI** (`apps/cli`): **Rust** (Cargo).
- **Runtime image** (`apps/runtime/image/Dockerfile`):
  - Base `node:22-trixie-slim`, a multi-stage build per provider, published to `ghcr.io/nuphos/runtime`.
  - Contains the OpenAB gateway (vendored) and ACP adapters (`@agentclientprotocol/*`).
- **Deploy targets:** Docker Compose, Helm/Kubernetes, Railway.
- **Monorepo tooling:** root Bun (`bun.lock`), ESLint, Prettier, Renovate.

## Sources

- https://nuphos.ai/ (homepage); https://nuphos.ai/pricing (404)
- https://github.com/nuphos/nuphos: README.md, LICENSE, NOTICE, package.json, apps/backend/package.json, apps/desktop/package.json, apps/runtime/README.md, apps/runtime/image/Dockerfile, apps/runtime/image/runtime-start.sh, apps/cli/README.md, apps/backend/src/routes/mcp.ts, apps/backend/src/lib/composio.ts, apps/backend/src/lib/cron.ts, apps/backend/src/config/byos-integrations.ts, apps/backend/src/lib/agent/builtin-skills/skills/google-workspace/SKILL.md, deploy/compose/README.md, deploy/openab-runtime-provisioner.yaml
- gh api repos/nuphos/nuphos (stars, dates, commit count)
- https://docs.nuphos.ai/introduction.md, /llms.txt, /billing.md, /agent/runtime.md, /connectors/mcp.md

## Deep-dive: browser, secrets, crons (2026-11-13)

Source: shallow clone of github.com/nuphos/nuphos (HEAD 2026-11-13) and docs.nuphos.ai. Paths below are relative to the repo root.

### 1. Agent browser

Nuphos has two browser paths. Neither uses Playwright, Puppeteer, Browserbase, Steel or Browser Use: I found no such dependency, and the only mention is `PLAYWRIGHT_BROWSERS_PATH` as a cache directory in `apps/runtime/README.md:335`.

- **(a) Desktop app on the user's machine: the in-app Electron browser exposed as the `local_browser` tool.**
  - It is Electron's own Chromium, using `<webview>` guests in the partition `session.fromPartition('persist:browser')` (`apps/desktop/electron/main/webview-guard.ts:44`).
  - **The browser is visible (headed).** The agent opens pages in the chat's dock, "so you watch the page it drives and type any password yourself" (docs/desktop.md#browser).
  - **Logins are manual:** the user types the password into the agent's tab. I found no credential injection, no password manager and no cookie import.
  - **Profile:** one persistent profile shared by all tabs ("Sign-ins are shared across tabs"). It is separate from the user's real Chrome profile. Chrome extensions can be installed in it (`electron/main/browser-extensions/host.ts`, with a patched `electron-chrome-extensions`).
  - **Tool surface** (`apps/desktop/electron/main/local-runtime/browser-stream.ts`, `BrowserCall`):
    - Actions: `tabs, open, dock, focus, close, navigate, eval, screenshot, fetch, show, record_start/stop`. The model therefore gets **JS eval and screenshots**; I found no accessibility-tree snapshot.
    - These calls travel from the backend over the device tunnel, in the `local_cua` frame shape.
  - **Network recording:** `record_*` writes a HAR file through CDP Network events (`browser-recording.ts`). Docs: the file is user-only and deleted after 1 day, and it "holds live cookies".
- **Isolation in the in-app browser:**
  - Per-conversation tab scoping: "it sees and drives only the tabs it opened" (`BrowserCall.session` comment). Tabs the user opened by hand are invisible to agents (docs).
  - `webview-guard.ts` lets only the `persist:browser` partition load arbitrary http(s) pages; `file://` is refused (`webview-guard.test.ts:86-92`).
  - Sign-in popups for Google, Apple and Microsoft are allow-listed (`SIGN_IN_HOSTS`).
  - Every permission except media (microphone) is auto-granted (`browser-sessions.ts`).
- **Codex's built-in browser** is gated by a signed `codex.browserAccess.v1` handshake per turn (`local-runtime/cua-browser-access.ts`).
- **(b) Cloud computers ("Box", instabox): a per-conversation Linux desktop.**
  - `apps/desktop/local-runtime/desktop-session.mjs` runs as the session's `nuphos-desktop` MCP server. It relays to instabox's computer-use MCP ("open-computer-use behind its proxy").
  - On the first tool call it takes a display from a pool and starts **Xvnc + XFCE** under the session's HOME. As a result, "screenshots, input and the browser profile are the session's own". That profile is per conversation and torn down when the session ends.
  - **Surface:** computer-use MCP (screenshots + input, vision-driven). Large screenshot results are dropped with a warning (`cua-stream.ts`).
  - **Live view and takeover:** "Every cloud computer has its own desktop. Open it from a chat's dock to watch the agent work." It is streamed over VNC (`vnc-stream.ts`, referenced in `desktop-session.mjs`).
  - The iOS app can also watch and control the user's own Mac screen through a Swift screen host (`local-runtime/mac-screen-host.swift`, which needs Screen Recording + Accessibility; docs/desktop.md#remote-desktops).
- **Computer Use on a local Mac:** in Auto Mode, the agent asks before taking control of an app (docs/security/auto-mode.md).
- **Not found:** stealth or anti-bot measures, captcha solving, user-configurable domain allow/deny lists, or browser-specific prompt-injection defenses beyond tab scoping [searched the repo, none found]. The triggers doc tells agents to "treat incoming payload text as data", but that is guidance, not enforcement.

### 2. Credentials / secrets

- **Integration secrets (server side):**
  - Encrypted as **AES-256-GCM envelopes** `{v, alg:'A256GCM', keyId, iv, authTag, ciphertext}` (`apps/backend/src/lib/byos/secrets/shared.ts`, `createSealer`).
  - Each provider has its own 32-byte key from an env var, e.g. `GITHUB_TOKEN_ENCRYPTION_KEY`, `LINEAR_TOKEN_ENCRYPTION_KEY`, `GRAFANA_BYOK_ENCRYPTION_KEY`, `CLOUDFLARE_BYOK_ENCRYPTION_KEY` (`byos/secrets.ts`).
  - Key rotation: a `<NAME>_PREVIOUS` fallback plus the `scripts/rewrap-byok-secrets.ts` script (`byos/rewrap.test.ts`).
  - No KMS or vault: keys are plain env vars, and the envelopes live in MongoDB.
- **Database connection credentials** are sealed separately (`lib/database-credentials.ts`, which uses `createCipheriv`).
- **Cloud accounts:** no long-lived keys are stored. Access is federated through AWS assume-role, GCP impersonation, and OIDC for Azure, Tencent and Volcengine, issuing short-lived least-privilege creds (docs/security/iam-trust.md; `byos/aws-*`, `byos/index.ts` `assumeRoleWithWebIdentity` / `assumeRoleWithOidc`).
- **Agents get short-lived generated kubeconfigs** per cluster (`byos/agent-kubeconfig/`).
- **Personal credentials** (Google, GitHub, Linear; `lib/personal-credentials/`):
  - These are OAuth grants with PKCE (`pkce.ts`), sealed at rest (`seal.ts`).
  - A **handout** gives the agent a fresh access token at turn time (`handout.ts`). GitHub and Linear fall back to the team token; Gmail and Drive are personal-only.
  - Only the turn's sender can use their own token. Others get 403 `personal_credential_owner_only`. Composio is one backend (`personal-credentials/composio.ts`).
- **Tokens are exposed to the agent:** the google-workspace skill's `setup-credentials.sh` fetches the token, and the agent curls the APIs with it. The token is therefore in the LLM's shell/context, but short-lived (~1h). There is no egress proxy or placeholder substitution [searched; none found].
- **Model subscriptions (Claude, Codex):**
  - These stay on the runtime computer as the CLI's own files: `/home/node/.claude/.credentials.json`, `/home/node/.codex/auth.json`, or the `CLAUDE_CODE_OAUTH_TOKEN` env var (`apps/runtime/image/runtime-start.sh:171`). Docs: "The sign-in stays on that computer".
  - On a local Mac, Claude Code uses the macOS Keychain (`local-runtime/claude-keychain.ts`).
  - Per-session `HOME` (`NUPHOS_SESSION_HOME`) isolates CLI creds per session.
  - [INFERENCE] The agent process itself can read these files and env vars, since they belong to the same OS user in the container.
- **Login codes in transit:** the device-auth code a user pastes in the app is sealed with AES-256-GCM bound to the login attempt (`claude-code-preview/runtime-login-store.ts` `sealAnswer`/`openAnswer`). The comment notes "it can be an API key or an AWS secret".
- **Redaction:** there is one backend scanner, `lib/secrets/scan.ts`. It uses **secretlint**'s recommended preset plus a custom `nuphos-rule.ts` with Shannon-entropy and url-credentials rules, and redacts matched ranges. "secretlint-disable" comments are ignored so agent output can't turn the scan off. Logs and telemetry are sanitized separately (`lib/observability-sanitize.ts`).
- **Approvals and access:**
  - Auto Mode surfaces the runtime's own permission prompts as approval cards. Unanswered requests are **denied after 2 min**.
  - Full Access auto-approves. It is per person and per conversation, never expires, and both the toggle and each auto-allowed action are recorded (docs/security/auto-mode.md).
  - Separate approvals gate destructive or high-risk cloud changes (docs/agent/approvals).
  - Access-control layers decide who can use which connected account (docs/security/access-control.md).
  - Cloud computers can be restricted to admins, everyone, or specific people (docs/agent/runtime.md).
- **Vendor visibility:**
  - Nuphos Cloud holds the integration ciphertexts together with the env keys, and stores transcripts in Mongo. [INFERENCE] The vendor can therefore decrypt integration secrets and read transcripts. Model subscription tokens stay on the runtime computer, but that computer is Nuphos-managed when using cloud computers.
  - Self-hosting keeps everything in your own Mongo and env.
- **Weaknesses:**
  - Encryption keys are env vars, not KMS.
  - The agent sees short-lived API tokens and the CLI login files.
  - Docs warn that sharing a computer shares its runtime sign-in (docs/billing).
  - HAR recordings contain live cookies (docs/desktop.md).

### 3. Crons / scheduling & triggers

- **Scheduler:** BullMQ on Redis (`apps/backend/src/lib/agent/trigger-scheduler.ts`).
  - Each cron trigger becomes a `queue.upsertJobScheduler(id, {pattern: cronExpression, tz: timeZone})`.
  - The Worker runs with `concurrency: 3`.
  - An hourly `expire-triggers` sweep (`0 * * * *`) handles triggers that have an `expiresAt`.
  - **Without Redis the scheduler is skipped** (`initTriggerScheduler` returns false and logs `redis_disabled`), so the Compose self-host has no crons unless Redis is added. Docs: "Self-hosted cron work also requires the backend scheduler to be enabled."
- **Syntax:**
  - Standard 5-field cron, validated with `cron-parser`.
  - The default timezone is `CRON_TIME_ZONE='UTC'` (`lib/cron.ts`). A per-trigger `timeZone` field exists (`isValidTimeZone`), but the docs tell users to convert to UTC by hand and to revisit at DST changes.
  - There is no natural-language input. The agent translates instead: you can "ask an agent to create or update one".
  - Recurring schedules support an optional expiry, so one-off-like use is possible. I found no dedicated one-shot type [INFERENCE].
- **Who creates them:**
  - The user, in Settings → Triggers.
  - The agent itself, via its tools. Docs: "Check for an existing trigger for the same job before adding another".
  - Limits: 50 per person and 500 per team (docs/agent/triggers.md).
- **What a run is:**
  - `executeTrigger` (`trigger-executor.ts`) resolves an authorized **target conversation** and delivers the rendered `messageTemplate` as a system-sender message (`trigger:<id>`).
  - This happens either in a new conversation per fire or in a **bound existing conversation**, which then accumulates context (`trigger-usage.ts` comments).
  - "Unbound Triggers never get here: authorization pauses them." Credential access is re-checked per fire (`trigger-credential-access.ts`, `trigger-executor-authorization.ts`).
  - The run executes on the agent's runtime, whether cloud computer, own server or laptop.
- **Overlap:** if the bound session is busy, the message is parked until the turn releases, and "identical parked fires coalesce". `fireId` (the BullMQ job id) dedupes redelivery. `lastFiredAt` is written before the turn starts.
- **Missed runs** (`trigger-missed-runs.ts`):
  - A sweep runs every 5 min. A fire that is more than 15 min overdue (`MISSED_RUN_GRACE_MS`) is recorded as `missedRunAt`, and the owner gets a push notification (`notifyNudge`) once per occurrence.
  - **There is no catch-up execution.** The run is only reported.
  - Failed jobs are logged (`agent.trigger_scheduler.job_failed`). I found no automatic retry config [INFERENCE from the Worker options].
- **Run history and cost:** the Trigger page shows per-fire and per-session token usage and `costUsd` over 7 days, for the last 50 fires (`trigger-usage.ts`). I found no per-run budget cap.
- **Permissions while away:**
  - Trigger-started conversations default to **Full Access**, so everything is auto-approved.
  - Events into an existing conversation keep the owner's mode. In Auto Mode, prompts are denied after 2 min when nobody answers (docs/security/auto-mode.md; docs/agent/triggers.md).
  - Questions wait in the desktop **Inbox** (docs/desktop.md).
- **Other triggers:**
  - **Webhooks:** POST with `X-Webhook-Secret` (or `?secret=`), and a 60 s default cooldown per trigger (`routes/agent-triggers.ts`; docs).
  - **Watches** on provider alerts (Grafana, Sentry etc.), and Watch Groups of 2–50 members.
  - **Database alerts** from monitored queries crossing thresholds.
  - GitHub and linked-PR events wake bound conversations.
  - Slack, Discord and Lark messages.
  - Resource turns go through the same queue (`resource-session-turn` job).
  - Not found: email or Gmail polling triggers, file-watch triggers.
- **Host off:** scheduling lives in the backend (Nuphos Cloud or your server). A fire targeting a laptop runtime that is offline cannot run there [INFERENCE]. Cloud computers and servers keep running (README).

### Sources (deep-dive)

- Repo (github.com/nuphos/nuphos):
  - Desktop browser: `apps/desktop/electron/main/{webview-guard.ts,browser-sessions.ts}`, `apps/desktop/electron/main/local-runtime/{browser-stream.ts,browser-recording.ts,cua-browser-access.ts,cua-stream.ts,claude-keychain.ts}`
  - Desktop sessions: `apps/desktop/local-runtime/{desktop-session.mjs,mac-screen-host.swift}`
  - Secrets: `apps/backend/src/lib/byos/secrets/shared.ts`, `apps/backend/src/lib/byos/secrets.ts`, `apps/backend/src/lib/secrets/scan.ts`, `apps/backend/src/lib/personal-credentials/handout.ts`, `apps/backend/src/lib/claude-code-preview/runtime-login-store.ts`
  - Triggers: `apps/backend/src/lib/agent/{trigger-scheduler.ts,trigger-executor.ts,trigger-missed-runs.ts,trigger-usage.ts}`, `apps/backend/src/lib/cron.ts`
  - Runtime: `apps/runtime/README.md`
- Docs: https://docs.nuphos.ai/desktop.md, https://docs.nuphos.ai/agent/triggers.md, https://docs.nuphos.ai/security/auto-mode.md, https://docs.nuphos.ai/agent/runtime.md, https://docs.nuphos.ai/llms.txt

## A. Agent browser

- **Two separate browser surfaces.** Neither uses Playwright, Browserbase or Steel. I found no Playwright or patchright in the repo grep.
- **(1) In-app desktop browser (user's machine):**
  - **Tech:** an Electron `<webview>` on one persistent partition, `persist:browser` (`apps/desktop/electron/main/webview-guard.ts`).
  - **Agent control:** the agent drives it through a tunnel from the local runtime. Actions include `tabs/open/navigate/eval/screenshot/fetch/record_start/record_stop` (`apps/desktop/electron/main/local-runtime/browser-stream.ts`, `browser-tabs.ts`). `record_*` writes a HAR file through CDP (`browser-recording.ts`: "HARs hold live cookies, so older ones are deleted").
  - **Headed and visible:** the browser is a Dock tab the user can watch and use.
  - **Profile:** "Browser guests use one isolated persistent session, shared by the user's tabs and the ones agents open" (webview-guard.ts).
    - So the agent reuses whatever the user logged into _inside Nuphos's browser_.
    - It is not the user's real Chrome profile. I found no cookie import from it [UNVERIFIED].
    - Chrome extensions can be installed into this session (`browser-extensions/host.ts`).
    - Each conversation "sees and drives only the tabs it opened" (`browser-stream.ts`).
  - **Light stealth only:** the user-agent is rewritten to plain Chrome, and a preload script adds `window.chrome` members because "Google sign-in also rejects a page whose `window.chrome` lacks Chrome's own members" (webview-guard.ts). There is no captcha solving or proxy rotation (repo grep for captcha/stealth found nothing).
  - Site permissions (devices, clipboard and similar) are denied by default.
- **(2) Computer use on a Linux cloud "Box" (instabox):**
  - **How it starts:** each conversation gets an `Xvnc + XFCE` display, started lazily by the `nuphos-desktop` MCP server (`apps/desktop/local-runtime/desktop-session.mjs`).
    - That server relays to "instabox's computer-use MCP (open-computer-use behind its proxy)".
    - The agent opens a Chromium/XFCE web browser via the desktop launcher. It is headed on the virtual display, and the browser profile lives under the session's HOME.
  - **Watch and take over:**
    - The owner watches over VNC/RFB streamed through the backend (`apps/backend/src/lib/claude-code-preview/runtime-desktop.ts`).
    - A "control frame" hands input to the human and pauses the agent's input tools.
    - Only the conversation owner is admitted.
  - **Documented weakness:** on a shared Box "every session there runs as one Unix user against an X server and VNC without authentication, so any agent on the Box can reach another session's display" (runtime-desktop.ts).
- **(3) Mac computer use:** a local runtime on macOS can stream and drive the Mac's own screen (`mac-screen-host.swift`, `computer-use-permission.mjs`, gated by `NUPHOS_CUA_PERMISSION_CLIENT`).
- All of these are exposed to the agent as MCP or bound tools, not as a separate product.

## B. Credentials and secrets

- **Integration secrets** (Grafana, BetterStack, DB credentials and others) are encrypted in MongoDB as **AES-256-GCM envelopes** `{v,alg:'A256GCM',keyId,iv,authTag,ciphertext}`.
  - The key is a **32-byte BYOK master key read from an environment variable**.
  - It rotates through `<NAME>_PREVIOUS` + `scripts/rewrap-byok-secrets.ts` (`apps/backend/src/lib/byos/secrets/shared.ts`; `config/byos-integrations.ts`).
  - The data-encryption key is not held in KMS. KMS is used only for signing (next bullet).
- **Internal agent tokens** are signed with an AWS KMS ECC P-256 key or a GCP Cloud KMS key in production ("private key never enters this process"), or a local PEM when self-hosting (`config/core.ts:39-54`).
- **Claude/Codex subscription tokens live raw inside the runtime container**, not in the Nuphos DB:
  - Claude: `/home/node/.claude/.credentials.json`, or the `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
  - Codex: `/home/node/.codex/auth.json`, seeded from the mounted secret `/runtime-auth/auth.json` (`apps/runtime/image/seed-codex-auth.sh`).
  - [INFERENCE] The agent's shell can therefore read them. The backend explicitly keeps `CLAUDE_CODE_OAUTH_TOKEN` out of provisioned containers' environment (`runtime-provisioner.test.ts:288`). Login answers in transit are sealed while stored (`runtime-login-store.ts`: "never stored readable").
- **Cloud and integration credentials are vended on demand, not pre-mounted:**
  - The credentials MCP surface lists what the conversation has selected, then fetches one value through the per-provider vending routes.
  - Its bearer is "a short-lived token scoped to exactly this (session, team) mount — never the user's general token" (`apps/backend/src/lib/claude-code-preview/credentials-mcp.ts`).
  - The per-turn `NUPHOS_TOKEN` is rewritten each turn and unset when revoked (`apps/runtime/image/runtime-guard.sh`).
  - AWS, GCP, Azure and others use short-lived federation (assume-role, impersonation, OIDC) with no long-lived keys (docs/security/iam-trust).
  - **Vended values do reach the sandbox shell.** This is a broker at call time, not a proxy that keeps secrets away from the LLM; e.g. the Gmail skill writes `GMAIL_ACCESS_TOKEN` to `~/.google/gmail.env`. Composio is the vendor for some connectors (`lib/composio.ts`, called with Nuphos's Composio API key).
- **Defences:**
  - Untrusted channel text is fenced with `fenceUntrusted` (`lib/agent/untrusted-content`, used in `db/channels.ts`).
  - Auto Mode / Full Access permission modes, plus approvals for high-risk cloud changes; Slack has approve buttons (`routes/slack-*-approve`; docs/agent/approvals).
  - Gmail tokens are owner-only (403 `personal_credential_owner_only`).
  - Per-session HOME isolates CLI credentials.
- **Audit:**
  - An append-only agent journal is sealed into S3 **WORM (Object Lock) segments** with signed manifests and a hash chain (`apps/backend/src/lib/journal/sealer.ts`).
  - The privacy policy also says the hosted service sends traces to Braintrust and conversation data to Anthropic, OpenAI, Google or AWS (https://nuphos.ai/privacy §7).

## C. Crons / scheduling

- **Firing:**
  - Triggers are `cron` or `webhook` (`lib/agent/trigger-db.ts`), stored in **MongoDB**.
  - **BullMQ repeatable jobs** on Redis, using `{ pattern: cronExpression, tz: timeZone }`, are run by an in-process worker with `concurrency: 3` (`lib/agent/trigger-scheduler.ts`).
  - Expressions use cron syntax via `cron-parser` and default to UTC, with an optional per-trigger IANA timezone (`lib/cron.ts`).
  - I found no natural-language schedule parser in the code. [INFERENCE] The agent writes the cron expression itself.
- **Without Redis** (the self-hosted Compose default), the scheduler logs `redis_disabled` and **does not start**. Cron triggers therefore need Redis, i.e. Helm or hosted (`trigger-scheduler.ts`; `deploy/compose/README.md`: "There is no Redis").
- **Missed runs:**
  - A sweep every 5 minutes flags a fire more than 15 minutes overdue and **sends a push notification ("Trigger missed a run … did not run")**.
  - It does **not** catch up or re-run (`lib/agent/trigger-missed-runs.ts`).
  - `lastFiredAt` is written before the turn runs.
- **Delivery and creation:**
  - Every fire is delivered into one existing conversation (`targetSessionId`).
  - **The agent can create, edit and test its own triggers** through the built-in `triggers` skill (`builtin-skills/skills/triggers/SKILL.md`, using the REST API with the conversation token).
  - Webhooks come from monitoring tools or other senders, e.g. BetterStack or Grafana alert-to-agent.
- **Limits:** 50 enabled triggers per owner and 500 per team, a 60s webhook cooldown per trigger, an hourly expiry sweep, and optional `expiresAt` (`config/agent.ts:34-40`, `trigger-service/quota.ts`).
- **Run history:** the desktop has a per-trigger run history page (`AgentHistoryPage.tsx`).
- **Laptop off:** the backend (cloud or self-hosted, with Redis) fires the trigger, and the turn runs on a cloud computer or always-on server runtime. If the target runtime is the laptop itself, the turn cannot run while it's off [INFERENCE].

## D. Stack scope clarification

- **Verified, open-source/self-hosted build (repo files):** everything in "Tech stack" above. That is Bun/Hono backend, MongoDB, optional Redis/BullMQ, S3/RustFS, the Electron desktop, the runtime image `ghcr.io/nuphos/runtime`, and Compose/Helm/Railway.
- **Hosted Nuphos Cloud:** I found no public infrastructure description.
  - The README says "Hosted-service deployment is managed separately". It lists what self-host lacks: "managed runtime provisioning, managed backups, and the operational tooling".
  - Code paths present in the repo but hosted-only in practice:
    - the Kubernetes runtime provisioner (`deploy/openab-runtime-provisioner.yaml`, per-team OpenAB pods)
    - the instabox (`@insforge/instabox-sdk`) cloud-computer client
    - Stripe billing
    - KMS-signed tokens
    - Braintrust traces
  - [INFERENCE] The hosted product runs the same open-source codebase plus private deployment config. I can't tell whether it uses a fork or extra closed services.
- **Cloud provider:**
  - `api.nuphos.ai` sits behind Cloudflare (`server: cloudflare`, observed 2026-11-13). The origin is unknown.
  - The privacy policy names subprocessors only generically and defers to trust.zeabur.com [UNVERIFIED, not fetched].
  - Code supports both AWS KMS and GCP KMS. Zeabur Inc. is itself a PaaS, so hosting on Zeabur's platform is plausible [INFERENCE, UNVERIFIED].

## E. Sandbox / agent computer: what it is used for

### 1. What the "computer" concretely is

- **Docs model** (docs/concepts; docs/agent/runtime):
  - A **computer** is a machine: "your laptop, your server, or a managed cloud computer". Older notes call the cloud computer a _Box_.
  - A **runtime** is a coding CLI installed on that machine (Claude Code, Codex, OpenCode, Grok Build, Antigravity).
  - An **agent session** runs on a runtime.
  - **The computer is the main execution place of the agent loop.** The vendor's agent harness runs on it, bridged by OpenAB/ACP. It is not merely a tool target.
- **Three kinds:**
  - **(a) Managed cloud computer.** An instabox VM ordered via `@insforge/instabox-sdk`.
    - It is "created with `vault: false`, so none of the account's secrets reach it". It can be paused and woken (`pauseBox`) (`apps/backend/src/lib/agent/devices/box-instabox.ts`).
    - It is per team, with an access list (admins, everyone, or specific people). You pick a name and a size (docs/agent/runtime).
    - Each one has "its own desktop" (Xvnc + XFCE, one display per conversation, `apps/desktop/local-runtime/desktop-session.mjs`).
    - The disk is persistent. Docs warn "conversation history is not a backup of its disk".
  - **(b) Your own machine or server:** joined with a one-time join command, or `nuphos agent` on a headless server.
  - **(c) This Mac:** a local runtime that "runs only while Nuphos is open".
  - In addition, there are self-hosted/K8s runtime containers (`ghcr.io/nuphos/runtime`), one long-lived container per runtime (`apps/runtime/README.md`).
- **Granularity:** the machine is shared per team or computer, and many conversations run on it. Isolation is per conversation:
  - per-session HOME (`NUPHOS_SESSION_HOME`, skills README)
  - a per-conversation display and browser profile (desktop-session.mjs)
  - per-chat browser tabs
- **Installed (runtime image, `apps/runtime/image/Dockerfile`):**
  - Baked in: curl, ripgrep, bubblewrap, socat, git, ssh, jq, python3+venv, `gh`, Node 22.
  - Installed on first use (`apps/runtime/image/tools/manifest.json`): kubectl, helm, aws, gcloud (+gke plugin), aliyun, tccli, volcengine, hcloud, linode-cli, zeabur, tailscale, mongosh, postgresql-client, mariadb-client, build-essential, plus the other agent CLIs.
  - Cloud Boxes add an XFCE desktop and a web browser (desktop-session.mjs).
  - I found no ffmpeg, pandoc or office tools in the manifest [UNVERIFIED for Box images].
- **What the agent can do:**
  - Run shell commands: `local_exec`, "inspecting files, running git, installing dependencies, or running a build".
  - Open a **shared interactive terminal** (`local_terminal`) for "development server, watcher, log tail", where "you and the agent can type into it" (docs/agent/local-commands).
  - Drive the in-app browser (`local_browser`).
  - Use GUI computer-use on a Box desktop.
  - Show artifacts (HTML app, SVG, document).
  - Clone and push with git/`gh`.
  - Operate clouds through their CLIs.

### 2. Concrete use cases shown by the project

| #   | Use case (source)                                                                                                                                                                                       | Needs the computer?                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | "Work in ~/code/my-app. Read the README, explain how to run the project, and identify one small improvement. Show me the proposed change before committing" (docs/quickstart)                           | Yes: shell/git on the chosen computer            |
| 2   | "Ship the new onboarding … add a skip option … I'm heading out. Run the onboarding checks and send me the results" on "Cloud Codex"; caption "The creation of a pull request" (nuphos.ai homepage demo) | Yes: cloud computer keeps running                |
| 3   | Migrate a Dokploy-hosted system to an EKS cluster and set up Terraform IaC (Photon testimonial, nuphos.ai)                                                                                              | Yes: kubectl/terraform/aws CLIs                  |
| 4   | Move services from Vercel to GKE for healthcare compliance; BetterStack uptime monitoring so "incidents get investigated automatically" (LunaBill testimonial)                                          | Yes, plus webhook triggers                       |
| 5   | Build Grafana observability dashboards for AWS in natural language (Monid testimonial); Dashboards page panels "the agent builds from your connected accounts" (docs/desktop)                           | Mostly API/connector calls [INFERENCE]           |
| 6   | Investigate infra and cut cloud costs (USPACE testimonial); approval cards list "steps, cost, risks and rollback" (docs/agent/approvals)                                                                | Yes: cloud CLIs with short-lived federated creds |
| 7   | "Design a booking flow": agent builds live HTML screens on the Designs canvas (docs/desktop)                                                                                                            | Artifact/canvas; computer used to run the agent  |
| 8   | Agent opens a website or sign-in page in the chat's dock with `local_browser`; "you watch the page it drives and type any password yourself"; HAR recording to debug a page (docs/desktop)              | Yes: user's desktop app browser                  |
| 9   | Webhook "high cpu" alert → agent investigation; a Watch wires a provider alert to a trigger; DB query threshold alerts (docs/agent/triggers)                                                            | Trigger in backend; turn runs on a computer      |
| 10  | Read and send Gmail, search Drive (built-in `google-workspace` skill, curl to REST APIs)                                                                                                                | Runs in the sandbox shell, but only API calls    |
| 11  | Process uploaded files and hand back downloads (built-in `file-transfer` skill)                                                                                                                         | Yes                                              |
| 12  | Built-in skills for kubectl, helm, argocd/fluxcd, eksctl, k8s-monitoring, soc2-incident-report, sentry, loki, architecture-diagram (`apps/backend/src/lib/agent/builtin-skills/skills/`)                | Mostly yes (CLIs)                                |

### 3. End-to-end flows

- **Flow 1: first coding task, local, then moved to cloud** (docs/quickstart, docs/agent/runtime):
  1. Install Desktop and sign in, then pick a local runtime (Settings → This computer) or an admin adds a "New computer".
  2. New agent → prompt as in example #1.
  3. The agent reads the repo and runs commands via `local_exec`. The transcript shows tool results, and the user can steer mid-turn and answer question cards.
  4. Auto Mode asks before risky runtime actions. The agent shows the diff before committing, as asked.
  5. To keep going after closing the laptop, the user moves the conversation to a cloud or remote runtime with the runtime picker. Docs warn to prepare the repo there first: "conversation history is not a file synchronization tool".
- **Flow 2: user absent, alert-driven** (docs/agent/triggers; code in `trigger-scheduler.ts`) [partly INFERENCE in composition]:
  1. The user or agent creates a webhook trigger bound to a conversation, via Settings → Triggers or the `triggers` skill.
  2. BetterStack or Grafana POSTs to the trigger URL with `X-Webhook-Secret`. There is a 60s cooldown per trigger.
  3. The backend starts a turn on the conversation's runtime (a cloud computer). "Automation conversations initially use Full Access".
  4. The agent investigates with kubectl/cloud CLIs and posts to the chosen Slack channel/DM or the conversation.
  5. If a destructive change is needed, an approval card waits in the Inbox, but "a trigger may run with nobody available to answer", so docs recommend read-only creds.
- **Flow 3: human approval / takeover:**
  - **Approval** (docs/agent/approvals): the agent proposes deleting or replacing a non-ephemeral cloud resource and posts a question card (steps, cost, risks, rollback) to the Inbox. The owner chooses Approve or Reject, and the agent continues or stops. "Delete X and rebuild it as Y" is two approvals.
  - **Takeover** (docs/desktop; `runtime-desktop.ts`): the agent opens a sign-in page in the dock browser, and the user types the password. On a cloud computer the owner opens its remote desktop, also possible from iOS. A control frame hands input to the human and pauses the agent's input tools until the stream closes.

### 4. File and data flow

- **In and out:** S3-backed short-lived transfer store. "Pull" brings user uploads into the sandbox; "push" hands files or zips to the user via signed URLs that move "directly between the sandbox and S3" (`builtin-skills/skills/file-transfer/SKILL.md`; `apps/backend/src/lib/file-transfer/`). Git clone/push via `gh` is the other route.
- **Artifacts** (HTML, SVG, documents, code) render in the dock with versions and share links (docs/desktop).
- **Local files:**
  - Only a local runtime or a joined machine sees its own files and sign-ins ("Local commands run with the computer user's permissions, including existing cloud and repository sign-ins", docs/agent/local-commands).
  - A cloud computer cannot reach the laptop's files: "A path on your laptop is not automatically a path on the remote machine" (docs/quickstart).
  - Local preview thumbnails stay on the device (`docs/local-previews.md`).
- **Egress:** I found no documented egress allow-list for runtimes or Boxes. The Helm NetworkPolicy only keeps runtimes away from MongoDB (`deploy/helm/README.md:138`; compose README). [INFERENCE] Outbound internet access is open.

### 5. Limits and caveats

- **Cost and capacity:** you buy capacity, not hours. Plans are 4/12/24 vCPU of _running_ capacity for $20/$50/$100 per month; paused computers don't count, and creation is refused once the plan's capacity is reached (docs/billing).
- No GPU option was found [UNVERIFIED].
- **Isolation gap:** on a shared Box all sessions run as one Unix user against unauthenticated X/VNC, so "any agent on the Box can reach another session's display" (`runtime-desktop.ts` comment).
  - Sharing a computer also shares its runtime sign-in and local logins (docs/billing, docs/agent/local-commands).
- **Session limits:**
  - A local runtime stops when the app or laptop closes.
  - `local_exec` commands that run too long may be stopped.
  - A running terminal is "not a durable schedule or monitor".
  - Cloud computer updates restart every agent on it (docs/agent/runtime).
- **Unattended runs:** they run with Full Access. Approvals are "an agent workflow, not a provider IAM policy".
- **Missed cron fires:** the user is notified, and the run is not caught up (`trigger-missed-runs.ts`).
- **Antigravity** runs only on cloud computers (docs/agent/runtime table).

## F. Scenario: nightly scrape to CSV on ChatGPT subscription, laptop off

### 1. Verdict

- **Yes, it should work, with conditions [INFERENCE]: the conversation must run on an always-on host where Codex is logged in with the user's ChatGPT account.** That host is either:
  - (a) a paid Nuphos Cloud computer (from $20/mo for 4 vCPU, docs/billing), or
  - (b) the user's own VPS joined to Nuphos Cloud (`nuphos agent`, or a self-hosted runtime container). This runs on the user's own server, but the scheduler is still Nuphos Cloud's backend.
- Fully self-hosted works only with Redis (Helm). In Docker Compose there is no Redis, so the cron scheduler never starts (`lib/agent/trigger-scheduler.ts`: returns false with `redis_disabled`; deploy/compose/README).
- It does **not** work with a local runtime on the laptop: "A local runtime runs only while Nuphos is open" (docs/agent/runtime).
- **Strictness note:** no doc or changelog explicitly shows a _scheduled_ run on a Codex/ChatGPT subscription.
  - The code shows triggers are delivered as an ordinary conversation turn on the conversation's runtime (`deliverToTargetSession` → `executeConversationTurn`, `apps/backend/src/lib/agent/trigger-executor.ts:74-108`). I found no runtime- or provider-specific restriction in that path.
  - So Codex-subscription unattended runs are [INFERENCE: supported by code path, UNVERIFIED in docs].

### 2. How ChatGPT auth reaches the always-on host

- **Which process calls the model:** the **Codex CLI on the host**. Specifically `@openai/codex` 0.167.0 behind `@agentclientprotocol/codex-acp`, supervised by OpenAB inside the runtime (`apps/runtime/README.md`). The Nuphos backend only streams ACP to it. "The runtime signs itself in and Nuphos holds no provider token" (`apps/backend/src/lib/claude-code-preview/runtime-quota-probe.ts` header).
- **Getting the login onto the host:** a device-code login run on the host itself.
  - From the app: runtime card → Sign in. `codex-login.mjs` "drives Codex's device-code login in an isolated `CODEX_HOME`", and the user approves on the OpenAI page.
  - Self-hosted alternative: `docker exec -it nuphos-runtime codex login --device-auth`.
  - Or the managed provisioner seeds it from a mounted secret `/runtime-auth/auth.json` (`seed-codex-auth.sh`).
  - I found no documented copy-from-laptop step [UNVERIFIED as a supported path; [INFERENCE] copying `~/.codex/auth.json` into `/home/node/.codex` would likely work].
- **Token storage:** `/home/node/.codex/auth.json` (mode 600) on the host's persistent volume or disk (runtime README sign-in table). It is not in the Nuphos DB.
- **Refresh with nobody present:** the Codex CLI refreshes its own `auth.json`. The seed script never overwrites a refreshed file on restart ("A refreshed auth.json belongs to the same binding", `seed-codex-auth.sh`). How the refresh token behaves long-term is OpenAI's business [UNVERIFIED].
- **Laptop login:** separate device-code logins create separate sessions. I found no documented conflict [UNVERIFIED].
- **Usage limit or provider error at 3am:**
  - The turn ends with "The model provider stopped this turn: …" (`CodexTurnFailedError`, `lib/claude-code-preview/codex-turn-failure.ts`). This is the failure path for policy refusals and provider errors; that a usage-limit hit lands here is [INFERENCE].
  - There is **no fallback model or provider** in the code paths I read.
  - The Desktop app has a quota probe that warns _before sending interactively_ (`runtime-quota-probe.ts`, desktop `runtimeQuota.ts`). That warning doesn't help an unattended fire.
- **Shared runtime:** if the runtime is shared, other teammates' turns consume the same ChatGPT quota (docs/billing).

### 3. Setup UX (cheapest viable: Nuphos Cloud + 4 vCPU plan, or own VPS joined)

1. Install Desktop and sign in, then create or join a team (docs/quickstart).
2. An admin opens Runtimes → Add runtime and chooses one of:
   - "New computer": pick a size and pay $20/mo for 4 vCPU via Stripe on first use.
   - "Connect your own machine": a one-time join command on a VPS, with no Nuphos computer charge.
3. On the runtime card, sign in to **Codex** with the ChatGPT account via device code (docs/agent/runtime step 3).
4. New agent on that runtime. Ask it to do the scrape once, interactively. That serves as the test run, and the user watches.
5. **Site login:**
   - There is no secrets vault for arbitrary website passwords in the docs.
   - On a cloud computer the user can open its remote desktop and log in by hand in the Box's browser. That profile persists on the Box under the session HOME (desktop-session.mjs; docs/desktop "Remote desktops").
   - Or the user can give credentials in chat or a file [INFERENCE; insecure].
   - The in-app `local_browser` lives on the _laptop_, so it is unusable at night.
6. **Schedule:**
   - Ask the agent to create it ("Manage triggers … or ask an agent to create or update one", docs/agent/triggers; `triggers` skill), or use Settings → Triggers.
   - It is a 5-field cron. Docs say "evaluated in UTC", so convert by hand, e.g. 02:00 Europe/Warsaw → `0 1 * * *` in winter.
   - The code also accepts a per-trigger IANA `timeZone` (`tz: timeZone` in `trigger-scheduler.ts`). Whether the UI exposes it is [UNVERIFIED].
   - Test with "test-fire" (`triggers/SKILL.md`: `POST $TRIGGER/test-fire`).
7. **Approvals:**
   - "Automation conversations initially use Full Access", but "Events in an existing conversation keep its owner's mode; Auto Mode requests can time out when nobody is present" (docs/agent/triggers).
   - So set the conversation to Full Access, or a 3am permission prompt may stall and time out.
   - Cloud-change approval cards don't apply to scraping.

### 4. At night, technically

1. A BullMQ repeatable job on Redis (hosted backend) fires. The worker sets `lastFiredAt` and calls `executeTrigger` (`trigger-scheduler.ts`).
2. The trigger's message is posted as a new turn into the bound conversation. A busy session parks it (`trigger-executor.ts:74`).
3. **If the Box is paused:**
   - `wakeOfflineBox` resumes it in the background. "a send queues, and the session queue starts the turn once the Box is back" (`lib/agent/devices/box-wake.ts`).
   - A resume is refused (402) if the team's vCPU limit can't fit it.
   - Boxes are created with `autoSuspendMs: 0`, "stays on until paused" (`box-instabox-create.ts:102`), so the Box normally doesn't sleep.
4. **Scraping:** Codex on the Box uses shell, python3 or curl. For a JS-heavy or logged-in site it uses the Box desktop browser through the computer-use MCP (`nuphos-desktop`), which brings up Xvnc + XFCE + the browser on demand (desktop-session.mjs).
   - Python libraries and Playwright are not preinstalled; the agent would pip-install them [INFERENCE].
5. **Writing the CSV:** the agent writes it with the shell or python to the Box's persistent disk, e.g. under the session HOME or the repo directory.
6. **Failures:**
   - There are no automatic retries for a failed turn in the trigger path I read. BullMQ jobs are logged on failure only (`_worker.on('failed')`).
   - A missed fire (backend down more than 15 minutes) produces a push notification "Trigger missed a run", with no catch-up (`trigger-missed-runs.ts`).
   - Captcha or bot walls: there are no stealth or solver measures on the Box. On an expired site login the agent can't do interactive takeover at 3am, so it fails and reports in the transcript.

### 5. Morning UX

- **Transcript:** open the conversation (Desktop or iOS) and read the agent's report. Per-trigger run history is in the History page (desktop `AgentHistoryPage.tsx`).
- **Getting the CSV out:**
  - The agent pushes it with the `file-transfer` skill, which gives a short-lived signed S3 download link (`builtin-skills/skills/file-transfer/SKILL.md`), or shows it as an artifact.
  - Alternatively, `git push` with `gh`, or via Gmail/Resend skills (email) or the Slack destination.
  - Slack file upload is [UNVERIFIED]; I found no `files.uploadV2` in the backend.
- **No synced folder to the laptop.**
- **Re-run:** send another message in the conversation, or `test-fire` the trigger.

### 6. Cost

- **Nuphos Cloud computer:** $20/mo flat for 4 vCPU of running capacity. It's billed monthly, not per run; a Box that stays on uses its allowance continuously (docs/billing).
- **Own VPS joined:** $0 to Nuphos plus the VPS cost [INFERENCE: joining a machine is not counted toward managed capacity, per docs/billing "Your own machines … are not managed-computer capacity"].
- **Model usage:** counted against the user's ChatGPT plan limits. "Nuphos does not add a model inference charge" (docs/billing).

### 7. Gotchas (silent-failure risks)

- **Local runtime chosen by mistake:** the trigger fires but the laptop is off. [INFERENCE] The turn queues or fails until the laptop comes back.
- **Fully self-hosted with Docker Compose:** no Redis means cron triggers never schedule. Only a startup warning log shows it.
- **Timezone:** the docs say UTC, so a schedule silently runs an hour off after a DST change unless the IANA `timeZone` field is set.
- **Auto Mode** permission prompts at 3am can time out, and the run stalls.
- **Usage limit or Codex refresh failure:** the turn ends with a provider error, with no fallback or retry.
- **Missed-run notice:** only for scheduler misses, not for a turn that ran but failed.
- **Site session expiry, captcha or bot detection:** there are no countermeasures, and takeover requires a human.
- **CSV location:** it sits on the Box disk until exported, and deleting or replacing the computer loses it ("conversation history is not a backup of its disk").
- **Shared Box exposure:** sessions share one Unix user, so other agents can reach the display, the browser profile with its site cookies, and the Codex login.
- **Trigger quota:** 50 per person; webhook cooldown is irrelevant here.

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

(Restructured per follow-up. The detailed evidence is in the previous section, "F. Scenario: nightly scrape to CSV on ChatGPT subscription, laptop off".)

**F1. Verdict**

- **Hosted (Nuphos Cloud): Yes [INFERENCE, code-backed].** Codex, signed in with the user's ChatGPT account, runs _on a Nuphos cloud computer_. Cron triggers fire from the hosted backend and are delivered as normal turns on that runtime (`apps/backend/src/lib/agent/trigger-executor.ts:74-108`).
  - It requires a paid computer plan ($20/mo for 4 vCPU, docs.nuphos.ai/billing).
  - No doc explicitly demonstrates a scheduled Codex-subscription run.
- **Self-hosted VPS:**
  - **Partially.** It works with the Helm chart plus Redis.
  - **It does not work with Docker Compose:** there is no Redis, so `initTriggerScheduler` returns false and cron never fires (`lib/agent/trigger-scheduler.ts`; `deploy/compose/README.md`).
  - Alternative: a VPS joined to Nuphos Cloud as "your own machine" works, because the hosted backend schedules.

**F2. ChatGPT subscription on hosted**

- **Allowed:** the runtime table lists Codex as "Your ChatGPT account | Cloud computer: Yes" (docs/agent/runtime).
- **Token path:** a device-code login _executed on the cloud computer_. On the runtime card: Sign in, then `codex-login.mjs` runs Codex's device-code flow in an isolated `CODEX_HOME`, and the user approves on OpenAI's page in their browser (`apps/runtime/README.md`).
  - Managed pods can also be seeded from a mounted secret (`/runtime-auth/auth.json`, `seed-codex-auth.sh`).
  - No laptop relay is involved, so it is independent of the laptop.
  - I found no documented upload of `~/.codex/auth.json` [UNVERIFIED].
- **Storage:** `/home/node/.codex/auth.json` on the computer's disk. "The sign-in stays on that computer" (docs/agent/runtime). Nuphos says it "holds no provider token" (`runtime-quota-probe.ts`).
- **Refresh:** the Codex CLI refreshes its own token. Nuphos never overwrites a refreshed file (`seed-codex-auth.sh`). Long-term unattended validity is [UNVERIFIED, OpenAI-controlled].
- **Model call origin:** from the cloud computer's IP. Nuphos documents no ToS analysis; the runtime README only notes vendor CLIs run "under the vendors' terms" [ToS risk UNVERIFIED].
- **Vendor credits:** none offered to the user. "Nuphos does not add a model inference charge" (docs/billing). The backend has internal token accounting (`lib/agent/model-pricing.ts`, Vertex/Bedrock prices), but no user-facing credits are documented.

**F3. Setup UX (hosted)**

1. Download Desktop, sign in, create a team.
2. Runtimes → Add runtime → New computer → pick a size. The admin pays the $20/mo plan via Stripe.
3. Runtime card → Codex → Sign in (device code via ChatGPT).
4. New agent → run the scrape once interactively as a test.
5. **Human step:** log in to site X (and solve any CAPTCHA/2FA) yourself on the computer's remote desktop (docs/desktop "Remote desktops"; iOS works too). The browser profile persists under the session HOME.
6. Ask the agent to "run this every night at 03:00 and give me the CSV". It creates a cron trigger via the `triggers` skill; alternatively use Settings → Triggers.
   - Docs say "evaluated in UTC", so convert manually.
   - Code accepts an IANA `timeZone` (`trigger-scheduler.ts`); UI exposure is [UNVERIFIED].
7. `test-fire` the trigger.
8. Set the conversation to Full Access. Auto Mode prompts "can time out when nobody is present" (docs/agent/triggers).
9. Choose the output: download link, email or git (see F5).

**F4. At 03:00**

1. The hosted BullMQ/Redis repeatable job fires (`trigger-scheduler.ts`) and posts a turn into the bound conversation.
2. A paused Box is resumed by `wakeOfflineBox` and the turn queues until it's back (`lib/agent/devices/box-wake.ts`). Boxes are created with `autoSuspendMs: 0` (`box-instabox-create.ts:102`).
3. **Scrape:** Codex runs curl or python in the shell. For JS-rendered or logged-in pages it uses the Box desktop browser via the computer-use MCP (`desktop-session.mjs`). Playwright is not preinstalled [INFERENCE: agent may install it].
4. **Output:** the CSV is written with python or the shell to the Box's persistent disk. Cookies persist in the session HOME browser profile.
5. **Failure handling:**
   - No automatic turn retry is visible.
   - A scheduler miss of more than 15 minutes sends a push notification "Trigger missed a run", with no catch-up (`trigger-missed-runs.ts`).
   - A provider error or usage limit ends the turn with "The model provider stopped this turn: …" (`codex-turn-failure.ts`; usage-limit path [INFERENCE]), with no fallback model.
   - Run history is on the desktop History page.

**F5. Getting the CSV out**

- A signed short-lived S3 download link via the `file-transfer` skill.
- A dock artifact.
- Email via the Gmail skill (team-admin Google OAuth client required) or Resend.
- Drive upload via the `google-workspace` skill.
- `git push` with `gh`.
- A Slack/Discord message in a thread; file attachment is [UNVERIFIED].
- There is no laptop folder sync and no Telegram.

**F6. Gaps and risks**

- **Cost:** a flat $20/mo for a 4-vCPU Box, which stays on continuously, so cost is not per run. ChatGPT usage counts against the user's plan limits.
- **Silent failures:**
  - Auto Mode prompt timeouts.
  - UTC/DST drift.
  - Usage limit at 3am.
  - Expired site login or captcha: there is no stealth or solving.
  - A failed turn sends no missed-run notice.
- **Isolation:** a shared Box puts all sessions under one Unix user, so other agents could reach the display, browser cookies and the Codex login (`runtime-desktop.ts` comment).
- **ToS:** subscription traffic comes from a cloud IP, and teammates on the same computer share the ChatGPT login [INFERENCE].
