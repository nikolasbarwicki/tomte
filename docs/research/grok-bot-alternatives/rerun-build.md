# Rerun (rerun.build) research (2026-11-13)

Not to be confused with rerun.io (visualization SDK).

## What it is

- "Hire AI coworkers": a team-oriented business-agent platform. A "Chief of Staff" agent interviews you, plans and builds a team of coworker agents; each gets a job, its own memory, skills and its own computer (browser + watchable screen), runs on schedules/webhooks and asks for approval before sending/paying/deleting (README; rerun.build).
- Repo: https://github.com/rerun-build/rerun, **AGPL-3.0** (LICENSE; engine package.json `AGPL-3.0-only`), plus TRADEMARK.md. Repo created 2026-10-29, last push 2026-11-13, ~1,045 stars, ~178 commits (GitHub API, seen 2026-11-13). Site banner: "Rerun is now open source under AGPL-3.0" (recently open-sourced).
- Company: Rerun (Rerun Cloud, app.rerun.build; contact help@rerun.build). Site claims "2,000+ users". Has "Rerun Experts" marketplace (README).

## Infra / self-hosting / laptop-off behavior

- **Cloud (default):** each workspace gets "one machine: a private computer in the cloud, isolated from every other account, that hosts every coworker of the workspace and holds the files, the databases and the credentials" (apps/docs/concepts.mdx). Site: "It runs 24/7, on its own machine… laptop shut: it still runs."
- **Self-host:** two services in docker-compose.yml: `app` (Next.js, apps/ui/Dockerfile) and `engine` (apps/engine/Dockerfile, volume `/data`, shm 2gb). Supabase runs outside (supabase.com free project or `npx supabase start`). Steps (README): clone → `cp .env.example .env` (Supabase URL/keys + OpenRouter key) → `npx supabase link … && npx supabase db push --include-seed` → `node scripts/self-host-check.mjs` → `docker compose up -d --build`. Docs cover Dokploy, HTTPS, extra servers (Tailscale), desktop/mobile against own server (apps/docs/self-host/*). INSTALL.md is an "install guide for AI assistants" (paste into Claude Code/Codex).
- **Topology:** one engine container per workspace; "Each workspace has exactly one server" (self-host/servers.mdx); extra machines attach "in one command".
- **Laptop off:** yes — engine is an always-on server/container; scheduling in-process via `croner` (engine package.json); webhook triggers at `app.rerun.build/api/t/...` (site; agents/automations.mdx). "Autopilot"/Chief of Staff answers coworkers' approval requests by your rules while away (README; pricing page).
- **Data/secrets:** app metadata/auth/storage/realtime in Supabase Postgres; per-engine libSQL + files in data-dir. Provider credentials and app credentials "stored on the workspace's server, in its data-dir, and never in Supabase" (self-host/models.mdx; agents/apps.mdx). Memory per coworker (`memory_write/recall`), shared/ space (engine README).
- **Sandboxing:** filesystem tool jailed to the agent's `workspace/`; shell has a "command-policy denylist"; isolation relies on running engine in its own Docker container (apps/engine/README.md). Browser = patchright-patched Chromium on Xvfb with openbox + x11vnc so humans can watch/take over (engine Dockerfile). No per-agent VM/container [INFERENCE from README: one container per workspace].

## Claude / Codex subscription use

- **Yes, both, first-class.** "Connect your own Claude or ChatGPT subscription" (Claude Pro/Max, ChatGPT Plus/Pro) via "AI providers" dialog; "The engine image ships the official Claude Code and Codex command-line tools" (self-host/models.mdx).
- Mechanism (source): `apps/engine/src/connections/claude-token.ts` stores `CLAUDE_CODE_OAUTH_TOKEN` + refresh token, refreshes against `https://platform.claude.com/v1/oauth/token` using Claude Code's client id; runs via `ai-sdk-provider-claude-code`. `codex-auth.ts` uses "The Codex CLI's own public OAuth client" (`auth.openai.com`) with device-code flow, writes Codex `auth.json`; runs via `ai-sdk-provider-codex-cli`. Code comment: "an undocumented flow we mirror so a user can connect a ChatGPT subscription without a terminal."
- ChatGPT-plan coworkers get Codex's image generation tool (models.mdx).
- Other providers: Anthropic, OpenAI, Google API keys; OpenRouter (with custom base URL); OpenCode Go/Console key; custom OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, LiteLLM, Groq, Together, Mistral, DeepSeek). Default "Rerun" Fast/Balanced/Smart tiers = OpenRouter (self-host) or Rerun credits (cloud). Site also lists "Grok".
- ToS/ban risk: none documented in docs I grepped [UNVERIFIED that none exists anywhere]; only the code comment acknowledging "undocumented flow".

## MCPs / apps / integrations

- **MCP client:** any MCP server (HTTP, SSE, local command) per coworker in expert-mode MCP tab, with headers/OAuth/env, `${VAR}` secrets; agents can self-register MCP via `mcp_register` tool (apps.mdx; engine README; `@modelcontextprotocol/sdk`).
- **MCP server:** Rerun API is solely an MCP endpoint `POST https://app.rerun.build/api/mcp/account`, 53 tools (coworkers, skills, schedules, triggers, apps, DBs, runs, templates); requires paid subscription (api/introduction.mdx; billing.mdx).
- **App catalog:** "200+ ready integrations" + "2,000+ apps through Composio" (README; site says 3,000+). Auth methods per app: Managed (Rerun brokers OAuth & proxies), OAuth (token on your machine), API key (masked form), Command (local MCP), None (apps.mdx). Apps installed **per coworker**.
- **Gmail specifically:** Google family (Gmail, Calendar, Drive, Docs, Sheets, …) and Microsoft family go through **Composio** OAuth; self-hosters must create their own Composio auth configs (`ac_...`) since seed ids are empty (self-host/services.mdx). Alternatively the agent's own browser can click through web apps.
- **Paid data / outreach partners:** Treg (`paid_data` tool, 4,100+ data tools) and Linkup (LinkedIn, WhatsApp accounts) — Cloud-only premium (README).
- **Chat channels:** web app, Electron desktop (macOS/Win/Linux, Quick ask hotkey), Expo mobile app; notifications in-app + email (desktop-app.mdx; human-in-the-loop.mdx). WhatsApp/LinkedIn as acting accounts (+$9/mo each). No Telegram/Discord chat-bot channel found in source grep [INFERENCE: not a chat-bot-in-messenger product].
- **Skills:** per-coworker skills (skill_create/update tools), app-provided read-only skills, templates library (110+ agents), soul/memory (agents/skills.mdx; README).

## Monetization

- Pricing (rerun.build/pricing, 2026-11-13): **Free trial** $0, 5 days, card required, up to 3 coworkers, 350 credits. **Pro $29/month** (yearly -20%): unlimited coworkers & seats, 500 credits/mo, private machine. Add-ons: +1,000 credits $10/mo; LinkedIn +$9/mo; WhatsApp +$9/mo. **Enterprise** custom (self-hosted infra, SSO, SLA).
- 100 credits = $1; credits only for Rerun-hosted models and paid data; BYO key/subscription costs nothing on Rerun side (billing.mdx).
- Self-host: "Free forever", AGPL; Cloud-only: template library, LinkedIn/WhatsApp/paid data/emails, support (README table). Experts program: 95% template sales, 20% referral.

## Differentiator

- Multi-agent "team" model with a Chief of Staff that designs/hires coworkers and an approval-routing Autopilot; aimed at SMB business ops (sales, marketing, invoicing), not personal assistant chat.
- Each workspace gets a full desktop (Xvfb+VNC, stealth patchright Chromium) that users can watch/take over — computer-use beyond APIs.
- Strongest subscription story: in-app OAuth for both Claude Pro/Max and ChatGPT Plus/Pro, mirroring CLI OAuth clients, with token-refresh handling; plus OpenCode Go and local models.
- Flat $29 with unlimited seats/agents; full product AGPL with docker-compose self-host; its own API is an MCP server.
- Weaknesses: open-sourced only ~2 weeks ago (repo created 2026-10-29); heavy deps (Supabase required, Composio for Google); shell isolation is a denylist within one container per workspace; reuse of Claude Code/Codex OAuth client ids is undocumented/ToS-sensitive; no messenger-bot channels (Telegram etc.); premium integrations cloud-only.

## Tech stack

- TypeScript pnpm monorepo (pnpm-workspace.yaml): apps/ui (Next.js 16.4, React 19.2, Tailwind, Vercel AI SDK), apps/engine (Node, Hono, `ai` v6 + @ai-sdk/anthropic/openai/google, ai-sdk-provider-claude-code, ai-sdk-provider-codex-cli, libSQL + drizzle-orm, croner, patchright, pino, ws, zod, vitest), apps/desktop-app (Electron 45, electron-vite, electron-builder/updater), apps/mobile (Expo 58, React Native 0.88), apps/docs (Mintlify-style docs.json/MDX [INFERENCE]).
- Supabase (Postgres, auth, storage, realtime; supabase/migrations, seed.sql); react-email; PostHog optional; Turnstile/hCaptcha.
- Deploy: Docker / docker-compose; engine image Debian with Xvfb, openbox, x11vnc, xdotool, Chromium, Codex CLI; Dokploy guide.

## Sources

- https://rerun.build/ ; https://rerun.build/pricing (seen 2026-11-13)
- https://github.com/rerun-build/rerun : README.md, LICENSE, docker-compose.yml, package.json, apps/engine/{package.json,README.md,Dockerfile}, apps/engine/src/connections/{claude-token.ts,codex-auth.ts}, apps/desktop-app/package.json, apps/mobile/package.json, apps/ui/package.json
- Docs (repo apps/docs, = docs.rerun.build): concepts.mdx, billing.mdx, desktop-app.mdx, agents/apps.mdx, agents/automations.mdx, api/introduction.mdx, self-host/{models,services,servers}.mdx
- GitHub API repos/rerun-build/rerun (stars, created/pushed dates, commit count)

## A. Agent browser

- **Tech:** patchright (stealth-patched Playwright) driving Chromium via `chromium.launchPersistentContext` (apps/engine/src/tools/builtin/browser.ts; Dockerfile `npx patchright install --no-shell chromium`). Built-in tool (`browser_navigate` etc.), not an MCP.
- **Headed vs headless:** `headless: !display` — headed on a virtual X display when one exists, else headless (browser.ts L80-84). Engine image ships Xvfb + openbox + x11vnc + xdotool (Dockerfile); `tools/virtual-display.ts`; separate `computer` tool for desktop control ("one screen per agent", tools/builtin/computer.ts L66).
- **Where:** inside the per-workspace engine container (Rerun Cloud machine or your own Docker host). Not on the user's machine.
- **Watch / take over:** yes; app reaches engine at `RERUN_ENGINE_BROWSER_URL` "to watch a coworker's screen" (docker-compose.yml); `apps/engine/src/desktop/takeover.ts` (MAX_TAKEOVER_MS = 15 min); HITL tool `request_takeover` (tools/builtin/hitl.ts L9). Viewer protocol (VNC-over-WS?) [UNVERIFIED].
- **Profiles:** persistent profile **per agent** ("persistent profile per agent", engine README); only cookies/consents/storage kept between calls, caches dropped (browser.ts L28-29). Separate profile — no import of the user's real Chrome profile/cookies found [INFERENCE from source grep]; user logs in via takeover.
- **Anti-bot:** patchright stealth; `tools/bot-wall.ts` detects Cloudflare/DataDome/PerimeterX/Imperva (waits for JS challenge to clear) and Reddit/Google/Amazon blocks (final). Tool description says it auto-accepts cookie banners. No captcha-solving service found [INFERENCE].

## B. Credentials and secrets

- **Storage:** plaintext files in the engine data-dir with mode 0600 (dirs 0700): per-agent `.env` (`lib/env-file.ts` L40-41), Vault items + OAuth tokens as JSON (`vault/tokens.ts`, `vault/store.ts` L155). Claude/Codex subscription tokens in a connection env file (`connections/claude-token.ts` keys `CLAUDE_CODE_OAUTH_TOKEN`/refresh/expiry) and Codex `$CODEX_HOME/auth.json` written per connection (`codex-auth.ts`; providers.ts L321-324). **No encryption at rest found** (no AES/keychain/KMS in engine; grep) [INFERENCE: relies on container/disk isolation]. Supabase only holds references ("never the value", docs agents/apps.mdx); the only "encrypted" in migrations is workspace archive objects (20261002140000_workspace_archives.sql).
- **Vendor-held:** Composio holds Google/Microsoft etc. OAuth tokens ("Composio brokers the third-party OAuth and holds the tokens", apps/ui/lib/composio/client.ts L1-3); the org-wide `COMPOSIO_API_KEY` stays server-side in the app, never in the engine. "Managed" auth: Rerun brokers OAuth and proxies calls (apps.mdx). On Cloud, Rerun operates the machine holding all files [INFERENCE: vendor can access].
- **Exposure to agent:** secrets are **injected as env vars** into processes the agent spawns: `agentProcessEnv` merges agent `.env` + attached Vault secrets (agents/process-env.ts), so `shell_exec` commands can read them (tools/builtin/shell.ts L18-19). Engine config (RERUN_API_KEY, pair token, hub URL) is stripped via an allowlist (`lib/child-env.ts`). CLI providers receive `CLAUDE_CODE_OAUTH_TOKEN` in env (providers.ts L269-271). Not a proxy/broker model except Composio/Managed apps.
- **Secrets kept out of the chat:** `request_secret` masked form; the agent "only learns which variable name was filled"; MCP configs use `${VAR}` resolved at runtime (apps.mdx).
- **Scoping:** apps/Vault items attached **per coworker**; MCP servers from the Vault get only their own item's vars (process-env.ts comment); foreman holds none (vault/runtime.ts).
- **Guards:** HITL tools `request_approval`, `request_spend`, `ask_user`, `request_takeover` (hitl.ts L9); docs: "stop and ask before they send, pay or delete". Filesystem jail with symlink-safe `resolveWithinReal` (tools/sandbox.ts); shell "command-policy denylist" claimed (engine README) — implementation not located [UNVERIFIED]. No explicit prompt-injection/exfiltration filter or audit log found [INFERENCE]; run history + per-run cost in Monitoring tab (billing.mdx).

## C. Crons / scheduling

- **Mechanism:** in-process scheduler in the engine: `runtime/scheduler.ts` ticks every 30 s (`TICK_MS = 30_000`) and calls `isDue` (`schedules/cron.ts`) using croner. Schedules = cron expression + optional IANA timezone, or one-shot `runAt` (schedules/loader.ts). State: per-agent schedule files in data-dir with `lastRunAt` [INFERENCE: file-based, via loader.ts].
- **Missed runs:** `isDue` computes next run after `lastRunAt ?? createdAt`; if past → fires on next tick. So after downtime it **catches up once** (not every missed occurrence) [INFERENCE from cron.ts L44-54]. Marked fired _before_ launch → at-most-once (scheduler.ts comment).
- **Concurrency/limits:** one in-flight run per schedule (`inFlight` map); skipped/deferred if the coworker has a live run using its screen (`coworkerBusy`); skipped while budget latched (Rerun credits) or Claude/ChatGPT plan limit latched (scheduler.ts).
- **Other triggers:** webhook URLs (`triggers/`, `app.rerun.build/api/t/...`); Linkup replies/accepts wake LinkedIn/WhatsApp coworkers (README); coworker-to-coworker calls; API (MCP endpoint).
- **Agent-created:** yes, `schedule_*` tools (tools/builtin/schedule.ts); Chief of Staff builds routines. Natural language is translated by the LLM into cron [INFERENCE].
- **Laptop-off:** fires as long as the engine container (Cloud machine or your server) is up; laptop irrelevant. Run history: sessions per schedule (`createSession(..., 'schedule')`) + notifications.

## D. Stack scope clarification

- **Verified (open source build):** everything in "Tech stack" comes from the public repo (docker-compose, Dockerfiles, package.json files, engine/ui source).
- **Hosted Cloud:** docs state "The coworkers, the chat, the board and the Chief of Staff are the same code in both"; Cloud adds machines "ready in 30 seconds", credits, Treg paid data, Linkup LinkedIn/WhatsApp, emails, template library, Weekly Rewind, SMS/Google/Apple sign-in (apps/docs/self-host/open-source-vs-cloud.mdx). Partner integrations live in the repo but are switched off; Cloud provisioning/orchestration code not found in repo [INFERENCE: private or config-only].
- **Hosting provider:** rerun.build and app.rerun.build resolve to 46.224.121.114 = AS24940 Hetzner Online GmbH (dig + ipinfo.io, 2026-11-13) → app likely on Hetzner [INFERENCE]; where the per-workspace engine machines run is [UNVERIFIED]. Supabase hosted (storage URLs `sucqmcejnrnvcdnrwhld.supabase.co` on site). No infra/ or terraform folder; workflows only ci/release/version. Privacy-policy subprocessors not checked [UNVERIFIED].

## E. Sandbox / agent computer: what it is used for

### 1. What the computer is

- **One Docker container ("machine"/"server") per workspace**, shared by all its coworkers; Cloud claims it "from a pool of ready ones: a private cloud computer, isolated from every other account" (apps/docs/quickstart.mdx §3; concepts.mdx). Self-host: the `engine` service (docker-compose.yml).
- **Lifecycle:** always-on, persistent data-dir volume `/data` (docker-compose.yml); detaching a server keeps the data-dir and "Attach the same server again and they come back" (self-host/servers.mdx). No sleep/wake documented [UNVERIFIED].
- **Per-coworker inside it:** private workspace dir (shell cwd), private SQLite DB, optional shared SQLite DB and shared folder, own browser profile, "one screen per agent" (agents/data.mdx; engine README; tools/builtin/computer.ts L66).
- **Installed:** Node 22 (bookworm-slim base), git, jq, Chromium (patchright), Xvfb/openbox/x11vnc/xdotool desktop, thunar file manager, xfce4-terminal, maim screenshots, Claude Code + Codex CLIs (apps/engine/Dockerfile; self-host/models.mdx). No Python/ffmpeg/LibreOffice in the image [INFERENCE from Dockerfile grep]; agents can `tool_install` npm packages into their workspace (engine README).
- **Capabilities (tool names, engine README/tools/builtin):** `shell` (timeout default 120 s, max 600 s; shell.ts L26), filesystem/`fs_edit`/`fs_search`, `browser_navigate` (read pages), `computer` + `open_app` GUI computer-use ("fill in a form, post, click through a web app", computer.ts L153-157), `db`/`shared_db`, `memory`, `skills`, `delegate_task`, `call_agent`, `schedule_*`, `paid_data`, `mcp_register`, page publishing.
- **Role:** the agent loop itself runs in this engine (it calls the models, incl. Claude/Codex CLIs spawned there), so the container is the main execution place, not just a tool target (README mermaid; providers.ts).

### 2. Use cases the project shows

| #   | Use case (source)                                                                                                                                                                     | Needs computer?                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Executive Assistant: morning briefing, inbox triage with drafted replies, calendar conflicts, meeting recaps, leadership deck with charts (rerun.build/templates/executive-assistant) | Mostly API (Gmail/Calendar via Composio); deck/charts = files in workspace [INFERENCE] |
| 2   | Sales Development Rep: "Finds prospects who fit and writes each one a first email" (README)                                                                                           | API + `paid_data`; browser for research                                                |
| 3   | Social Media Manager: week of posts per network, "published when you say go" (site, README)                                                                                           | API/Linkup; GUI computer-use for posting where no connector ("post", computer.ts)      |
| 4   | SEO Strategist: ranked audit vs competitors, weekly rank check (site template seo-consultant)                                                                                         | Browser + paid data                                                                    |
| 5   | Ads Manager: review Google/Meta/LinkedIn/TikTok ads, flag wasted spend (site template paid-acquisition-manager)                                                                       | API                                                                                    |
| 6   | Data Analyst: answers from your data "with charts and a weekly KPI report" (README)                                                                                                   | Yes: SQLite DB, files, shell                                                           |
| 7   | Collections Specialist: "Chases every late invoice" (README); site routine "Chase unpaid invoices every weekday at 07:00"                                                             | API (Stripe/Gmail) + schedule                                                          |
| 8   | Webhook: "When Stripe posts a refund, handle it" / "Flag a failed payment" (quickstart.mdx; site)                                                                                     | API                                                                                    |
| 9   | "A coworker sending an email from its own browser" (README features/computer.gif); "opens your apps on its own screen and clicks through them, even those nothing plugs into" (site)  | Yes: GUI                                                                               |
| 10  | Editorial Writer: sourced article, fact-checked; publish HTML/report to `app.rerun.build/p/<slug>` (site template; agents/data.mdx "Publishing a file")                               | Files + publishing                                                                     |

- Not shown anywhere: coding/PR workflows, dev servers with preview URLs, devops — the product targets business ops [INFERENCE].

### 3. User flows

**Flow 1 — onboarding a template (documented, quickstart.mdx):** sign up → answer 3 questions → pick template (e.g. Executive Assistant) → place on board; workspace claims a machine in seconds → "Start installation": coworker lists needs, raises app cards (e.g. Gmail sign-in) and masked secret forms → coworker turns on its shipped schedules/webhooks and says when it runs next → user chats, sees every file read/tool call live.

**Flow 2 — user absent, approval queued (documented pieces: automations.mdx, human-in-the-loop.mdx):** schedule fires (30 s tick, scheduler.ts) e.g. "Chase unpaid invoices 07:00" → coworker reads invoices via app, drafts emails in its workspace → hits `request_approval` card listing each email (approve/decline per item) → run pauses, notification goes to app + email ("so a 3am approval actually finds you") → user approves later from phone/desktop (or Autopilot answers within rules, README) → run resumes and sends. [INFERENCE: concrete invoice example combines site routine + HITL docs.]

**Flow 3 — computer-use with takeover (README features; computer.ts; hitl.ts):** user: "post this on X / fill this form" → coworker `open_app` browser, drives it with `computer` screenshot-by-screenshot; user can watch the live screen → login wall → `request_takeover` → user takes control (≤15 min, desktop/takeover.ts) and signs in; cookies persist in that coworker's profile → coworker continues, asks approval before posting. [INFERENCE: assembled from documented tools.]

### 4. File/data flow

- In: upload via Files tab of the coworker or shared folder in Knowledge base ("Dropping a file into a coworker workspace is how you give it something to work on"); chat attachments/voice notes (README); apps/MCP; browser downloads (`download` tool).
- Between agents: shared folder + shared SQLite DB (agents/data.mdx).
- Out: publish file to public URL `app.rerun.build/p/<slug>` (25 MB max, single file, inline assets); DB export CSV/JSON; API `db_query`/`space_db_query` (agents/data.mdx). Workspace archives encrypted object upload (supabase migration 20261002140000).
- No access to the user's local files (cloud machine; docs: "a cloud machine cannot reach your computer", self-host/models.mdx). Egress: unrestricted internet [INFERENCE]; only a per-host circuit breaker (`tools/host-breaker.ts`), no allowlist found.

### 5. Limits / caveats

- Computer-use capped at 200 actions per run (60 for Claude/Codex CLI providers) (computer.ts L32-33); takeover max 15 min; shell 10 MB output buffer.
- One screen per coworker: a schedule won't fire while that coworker has a live run using it (scheduler.ts).
- Resource caps/CPU/RAM/GPU of Cloud machines not documented [UNVERIFIED]; no GPU [INFERENCE]; flat $29/mo, no per-hour compute fee (pricing page).
- Isolation is per workspace only: all coworkers share one container, and env-injected secrets are readable by shell commands (see B).
- Trial: 3 coworkers active at once (billing.mdx).

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

### F1. Verdict

- **Hosted (Rerun Cloud Pro $29/mo, or the $0 5-day trial): YES.** A ChatGPT Plus/Pro plan is connected in the web app with a device-code login, and the token lives on the workspace's always-on cloud machine. The engine runs the Codex CLI there and refreshes the token itself, so the laptop plays no part (self-host/models.mdx; connections/codex-auth.ts; pricing page: "Connect your own AI subscription or API key" is listed even in the Free trial). The cloud plan doesn't force credits: "When a coworker runs on … your Claude or ChatGPT subscription, it costs you nothing on the Rerun side" (billing.mdx).
- **Self-hosted on a VPS: YES**, same code. `docker compose up` on the VPS plus a Supabase project; the ChatGPT connect flow is identical (README; docker-compose.yml). Self-hosted on the laptop: **no**, because the laptop is off.
- Conditions for both: no approval or question pauses the run, the site's cookies are still valid, and there is plan quota left. I found no code that refuses a ChatGPT subscription in scheduled runs: the scheduler resolves the model via `automationModel(...)` and only skips when the plan-limit latch is set (runtime/scheduler.ts L36-41; agents/availability.ts L113-130). Not run live [UNVERIFIED end-to-end].
- Model calls go out from Rerun's cloud machine. The workspace app domain resolves to Hetzner (AS24940) [INFERENCE that engines are there too]. Neither Rerun nor OpenAI documentation that I read addresses ToS for this; the code calls the flow "undocumented" (codex-auth.ts).

### F2. ChatGPT-subscription crux: how the login reaches the always-on host

- **Who calls the model:** the official **Codex CLI shipped inside the engine image**, spawned by the engine through `ai-sdk-provider-codex-cli` (self-host/models.mdx "The engine image ships the official Claude Code and Codex command-line tools"; engine package.json). It runs in the workspace container (Cloud machine or your VPS), not on the laptop.
- **Login:** **device-code OAuth** from the web app, without a terminal: the app requests a user code at `https://auth.openai.com/api/accounts/deviceauth/usercode`; the user approves at `https://auth.openai.com/codex/device`; the app polls for the token (apps/ui/lib/engine/codex-oauth.ts L1-22). It uses the Codex CLI's public client id `app_EMoamEEZ73f0CkXaXp7hrann`. The code calls this "an undocumented flow we mirror" (engine/src/connections/codex-auth.ts). No auth.json upload or copy from the laptop is needed.
- **Storage:** plaintext in the engine data-dir: a connection `.env` (`CODEX_OAUTH_*` access/refresh/id token, account id, expiry; 0600), materialised into `$CODEX_HOME/auth.json` per connection before each run (codex-auth.ts `writeAuthFile`, `ensureCodexAuth`; providers.ts L321-324). On Cloud, that is on Rerun's machine.
- **Unattended refresh:** the engine refreshes the token itself before each run when it expires within 5 min (`REFRESH_SKEW_MS`) against `auth.openai.com/oauth/token`, persists the rotated refresh token, and reconciles anything the CLI rotates mid-run (codex-auth.ts L64-87, L105-120). A 400/401 marks the credential rejected (`recordCredentialRejected`). Runs then fail until the user signs in again (same comment in claude-token.ts).
- **Plan limit at 3am:** usage windows are read from Codex rate limits (connections/plan-limits.ts `planLimitWindowsFromCodex`). Once limited, `isPlanLimitLatched` is true until `resetsAt` (or a 30-min probe), and the scheduler throws `subscriptionLimited`. That is **before** `markFired`, so the schedule stays due and fires on the first tick after reset. The skip is logged at **debug** level only (scheduler.ts L73-86). No automatic fallback to another model for the run, except that a stale or unusable automation model falls back to the box default (availability.ts L107-118).
- **Laptop conflict:** the server holds its own token lineage from a separate device-code login, so it does not share tokens with the laptop's `~/.codex/auth.json` [INFERENCE]. Whether OpenAI limits concurrent sessions is [UNVERIFIED].

### F3. Setup UX (hosted: Rerun Cloud trial then Pro)

1. Sign up at app.rerun.build. Starting the trial asks for a card, $0 today (billing.mdx). The workspace claims a cloud machine in seconds (quickstart.mdx §3).
2. Workspace menu → **AI providers** → ChatGPT plan → **Connect**: device-code sign-in (self-host/models.mdx; codex-oauth.ts).
3. Create a coworker from scratch, describe the job, and set its model to the ChatGPT plan (model picker → **Set as default**), or set a per-task model (automations.mdx "Each task can carry its own model").
4. Site login: ask the coworker to open the site. On the login wall it raises `request_takeover`; the user signs in on the coworker's live screen (≤15 min) and cookies persist in that coworker's browser profile (hitl.ts L9; desktop/takeover.ts; browser.ts persistent context). For an API-key style login there is a masked `request_secret` form.
5. Schedule: **Scheduled runs** tab form (Name, Instruction, 5-field Cron, IANA Timezone), or "just ask the coworker to set it up" in natural language (automations.mdx; tools/builtin/schedule.ts). Without a timezone the cron follows "the timezone of your machine" (the engine host).
6. Test: **Run now** fires immediately without touching the schedule (automations.mdx).
7. Approvals: unattended runs **still pause** for approval or questions until you answer ("deliberate", automations.mdx). README/pricing mention an "Autopilot" where the Chief of Staff answers within your rules, but the exact settings were not traced [UNVERIFIED]. Write the instruction so no consequential action (send/pay/delete) is needed.

### F4. Technical execution at 03:00

- The in-process engine scheduler ticks every 30 s; `isDue` compares the cron against `lastRunAt`. The machine is always on, so nothing needs waking (scheduler.ts; schedules/cron.ts). A fresh session `schedule: <slug>` starts, with notification event `agent.session.created`.
- The engine refreshes the Codex token and writes auth.json, then spawns the Codex CLI agent loop with Rerun's tools.
- Fetching: `browser_navigate` (patchright Chromium, persistent profile per coworker, auto-waits on Cloudflare/DataDome JS challenges via tools/bot-wall.ts), or `computer` GUI actions (max **60 actions per run on CLI providers** such as Codex, computer.ts L32-33).
- The CSV is written with the filesystem tools or `shell` (Node is present; Python is not in the image [INFERENCE]) into the coworker's private workspace dir in persistent `/data`. Alternatively rows go into the coworker's SQLite DB and the user exports CSV (agents/data.mdx).
- **Failures:**
  - The run is marked fired before launch, so it is at-most-once with **no retry** (scheduler.ts comment).
  - A hard bot wall (Google/Amazon/Reddit captcha) is reported as final (bot-wall.ts).
  - Expired site login: the agent can only `request_takeover`, which pauses until morning.
  - Expired OAuth: the run fails.
  - Errors produce notifications, in-app plus email (rate-limited, digest after 3 per source per 15 min; human-in-the-loop.mdx).

### F5. Getting the CSV out

- Open the coworker's **Files** tab and download the CSV, or ask it to **publish** the file to `https://app.rerun.build/p/<slug>` (≤25 MB) (agents/data.mdx). Optionally the instruction can email it via a connected Gmail app or post to Slack (apps).
- Run history is in **Monitoring** and **Logs** (automations.mdx). Each run is its own session in chat. **Run now** re-runs it. The desktop/mobile app shows notifications.

### F6. Gaps and risks: cost

- Rerun Cloud: **$29/month** Pro (or 5-day $0 trial, 3 coworkers). No per-hour compute charge (pricing page). Model usage on the ChatGPT plan "costs you nothing on the Rerun side" and counts against the ChatGPT plan's limits (billing.mdx; models.mdx).
- Self-host: $0 for the software, plus your VPS and Supabase (free tier possible).

### F6 (cont.). Gaps and risks

- **Silent skip:** a plan-limit latch or a busy coworker (a live run holding its screen) skips the fire with only a debug log. It retries next tick, so it is delayed, not lost; but nothing notifies the user of the skip itself [INFERENCE from scheduler.ts L73-86].
- **Approval pause:** the run sits until morning if the model decides to ask (by design).
- **Login cookies** expire. The 3am run can't re-login without a takeover, unless the credentials are stored and the agent types them [INFERENCE].
- **Refresh-token death** (400/401) breaks every later run until the user re-connects. It is logged as an error and the credential is marked rejected. Whether the user is notified of this is [UNVERIFIED].
- **Undocumented OAuth client reuse:** OpenAI could break it or object under its ToS. Rerun documents no ban-risk warning.
- **60 GUI actions per run on Codex:** a long click-through scrape may hit the cap. Prefer `browser_navigate`.
- **Fresh session each run:** state must be kept in the DB or memory (automations.mdx "Continuity between runs").
- **Missed runs:** if the host was down, only one catch-up run happens, not every missed night. The timezone defaults to the host's if unset.
