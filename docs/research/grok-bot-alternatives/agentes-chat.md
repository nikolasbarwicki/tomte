# agentes.chat research (2026-11-13)

## 1. What it is

- Open-source, self-hostable **team chat (Slack alternative) where people and AI agents share channels/DMs**; agents have a role, owner, monthly budget, own computer + browser, routines, memory, and approval cards for sensitive actions (README; https://agentes.chat/). Site says "Open beta", waitlist text "Arriving November 11".
- Repo: https://github.com/agentes-chat/agentes-chat — **AGPL-3.0-only** (+ NOTICE: app-store distribution permission and 7(b) attribution "Based on agentes.chat by Codari Global, LLC"); `packages/setup` is MIT; name/logo trademarked (TRADEMARKS.md). ~1,330 stars, created 2026-11-09, last push 2026-11-13, ~8,228 commits (GitHub API, 2026-11-13) — history apparently imported at publication `[INFERENCE]`.
- Company: **CODARI GLOBAL, LLC**, Orlando FL (site footer). Commit timezone -0300 and pt-BR-first ADR text suggest Brazilian team `[INFERENCE]`.
- README explicitly positions itself vs "Grok Bot, ChatGPT dots, OpenBot.run and OpenMausBot (all of which it imports from)".

## 2. Infra / self-hosting / laptop-off behavior

- **Server**: one Bun process (web app, API, WebSockets, background workers) + Postgres 18 w/ pgvector; optional Tailscale sidecar or Caddy for public HTTPS; optional backup container (pg_dump to S3) (SELF_HOSTING.md, docker-compose.yml, Dockerfile). Image `ghcr.io/agentes-chat/agentes`; Cloud runs the same image.
- **No Redis/external queue**: "The queue lives in the database itself" (site); Postgres outbox (docs/adr/0005-postgres-outbox.md).
- **Self-host**: `curl -fsSL https://agentes.chat/install | sh` → installs Docker (asks), pinned Bun, writes `.env` with secrets, compose up, migrations on boot, private HTTPS at `https://agentes.<tailnet>.ts.net`; alt `npx @agenteschat/setup`, public domain via Caddy, or no-Docker `agentes-server` single binary with built-in DB (beta). Suggested 2 vCPU/4 GB/20 GB; image ~2 GB (SELF_HOSTING.md).
- **Agent computers**: agents execute on a machine running `agentes-runner`: by default the self-hosted server itself; or any server/VM/laptop you connect; desktop app can run the server locally (Mac/Linux). On Cloud "each workspace gets a computer of its own, always on" (README; ADR 0077). Earlier Daytona per-agent sandboxes were removed (ADR 0021 superseded by 0077, 2026-10-28).
- **Laptop off**: yes, keeps working when hosted on a server/Cloud — routines run on schedule or events (GitHub PR, Sentry issue, new task, incoming email) and deliver to channel/DM/Drive; push to mobile app (README). If the only connected computer is your laptop, computer-bound tasks need it on `[INFERENCE]`.
- **Data/secrets**: everything in Postgres; files on disk volume, Postgres, or S3-compatible bucket. Model keys encrypted with key derived from `AGENTES_SECRET`, never sent to browser. Subscription sign-ins live only on the agent computer (`token.json`/`provider.json`, mode 600; `~/.claude`, `~/.codex`), never in server DB (SELF_HOSTING.md).
- **Isolation**: default runner = agents run as runner's OS user (per-agent folder, path checks, secret redaction, per-agent GIT_CONFIG; OS doesn't stop cross-agent access); `install.sh --system` = each agent its own Linux user, systemd/BPF; ADR 0030 proposes Seatbelt (macOS)/bubblewrap (Linux) "protected mode" (Status: Proposed). Approvals for merge/deploy/rollback; Postgres connector read-only.

## 3. Claude / Codex subscription use

- **Yes, both.** On a connected computer an agent can "think with Claude Code or Codex, on the plan signed in there, instead of through the API. Codex is still in testing" (README).
- Claude mechanisms: `cli_login` (Claude Code's own login, refreshed by Claude Code) or `setup_token` (`claude setup-token` long-lived token, held by runner, passed to Claude Code via file descriptor, not env) (apps/server/src/operator/claude-auth.ts; SELF_HOSTING.md). ChatGPT: Codex's own `auth.json` copied per turn (apps/server/runner/brain-codex.ts; SELF_HOSTING.md). Gemini via Antigravity CLI sign-in file (SELF_HOSTING.md).
- API keys: Anthropic, OpenAI, Google Gemini, DeepSeek, Kimi, Z.ai, MiniMax, OpenRouter (any model); README also mentions Grok. Router model "Jev" via TypeSafe key (SELF_HOSTING.md).
- ToS note: "It never moves to another account by itself: subscriptions are personal and rotating them to get around limits can break the providers' terms" (docs/adr/0041-claude-accounts-per-agent.md). Site: "With your own API key or plan, your agreement with that AI provider applies." No explicit ban-risk warning found `[UNVERIFIED]`.

## 4. MCPs / apps / integrations

- **MCP client**: org connects MCP servers once (one-click official Linear, Sentry, Notion, Stripe, or any URL); per-agent scopes (README; ADR 0016). "50+ apps in one click" (site). Not an MCP server/marketplace `[UNVERIFIED]`.
- **Composio** (`COMPOSIO_API_KEY`, operator-supplied) for Gmail/Outlook mailboxes, Google Drive/Calendar/Sheets/Docs, Slack, Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox, Instagram, LinkedIn, YouTube, Reddit, WhatsApp Business... — Composio holds the connections and data passes through it. **Gmail = via Composio**; other mail via IMAP/SMTP directly; sending asks approval by default (README; SELF_HOSTING.md).
- Native connectors (own OAuth): X, TikTok, Threads, Meta Ads, Telegram (ADR 0170). GitHub via own GitHub App (short-lived scoped tokens, git proxy). Postgres read-only connector. Web search (DuckDuckGo/Brave/SearXNG), `agent-browser` with live view/takeover (beta).
- **Channels**: it _is_ the chat — web, desktop (Tauri; macOS/Win/Linux), iOS/Android (Expo). External chat apps only as connectors (Slack/Teams/WhatsApp Business via Composio, Telegram native), not primary front-ends `[INFERENCE]`.
- **Skills**: `SKILL.md` from zip/GitHub/editor, versioned (README; ADR 0020). Wiki, Drive, tasks board, memory. Importers from Grok Bot, ChatGPT dots, OpenBot.run, OpenMausBot, Hermes Agent, OpenClaw, Paperclip.

## 5. Monetization (site, 2026-11-13)

- **Free**: $0 self-hosted, all features, AGPL, no license key/per-seat fee.
- **Personal** $29/mo or $288/yr: 1 user, unlimited agents, always-on cloud computer, 50 GB.
- **Team** $49/mo or $480/yr: up to 10 people (15 with extras at $4/person/mo), 200 GB.
- **Business** $99/mo or $984/yr: up to 25 (50 with extras at $4/mo), bigger computer, 500 GB.
- "AI usage is never on our bill" — BYO keys/plans. Open-source, not open-core ("no limited edition").

## 6. Differentiator

- Multi-user **team chat** with agents as workspace members (router picks up to 4 responders without @mentions, agent-to-agent consults) vs single-player bots.
- Strong governance: per-agent owner, monthly budget checked before each call, approval cards that bind (merges via GitHub App only after approval).
- Fully AGPL, same image as Cloud, Postgres-only infra, Tailscale-private default install; huge ADR trail (170+ ADRs).
- Explicit importer from competitors (Grok Bot, OpenBot.run, OpenMausBot).
- Weaknesses: public only since 2026-11-09, many features Beta (browser, desktop, mobile, mailboxes, Codex); Gmail etc. depend on third-party Composio; default runner isolation is weak (OS sandbox only proposed); ~2 GB image, heavy; sizing "not measured".

## 7. Tech stack

- TypeScript on **Bun 1.4** (bun workspaces, bun.lock), **Hono** + zod-openapi API, **Drizzle** ORM, **PostgreSQL 18 + pgvector**, PGlite for tests (ADR 0003); Postgres outbox queue; WebSockets.
- Web: React + Vite + TanStack; mobile: Expo (React Native, Skia); desktop: **Tauri** (Rust, `apps/desktop/src-tauri`).
- Runner: `apps/server/runner` bundled to Node script `agentes-runner.mjs`; drives Claude Code / Codex CLIs; `agent-browser`, Chrome.
- Packages: adapters, client, config, db, engine, i18n (14 langs), modules, providers, setup, tokens, ui. Biome lint, TS 7, CI GitHub Actions. Deploy: Docker Compose, Tailscale/Caddy, S3 backups.

## Sources

- https://agentes.chat/ (markdown via content negotiation, 2026-11-13)
- https://github.com/agentes-chat/agentes-chat — README.md, SELF_HOSTING.md, docker-compose.yml, Dockerfile, package.json, LICENSE/NOTICE, CLAUDE.md
- docs/adr/0005, 0021, 0030, 0041, 0077, 0170, README.md
- apps/server/src/operator/claude-auth.ts, apps/server/runner/brain-codex.ts
- GitHub API repos/agentes-chat/agentes-chat (stars, dates, commit count)

## Deep-dive: browser, secrets, crons (2026-11-13)

Source: shallow clone of agentes-chat/agentes-chat (HEAD 2026-11-13). Paths relative to repo root.

### 1. Agent browser

- **Tech**: Vercel Labs **`agent-browser`** (Rust CLI + daemon speaking **CDP**, no Playwright/Node), pinned release, SHA-256 checked before running (apps/server/runner/browser.ts header comment; docs/adr/0040-agent-browser.md). Drives the computer's own **Google Chrome stable** (Chromium on Linux ARM); Chrome for Testing removed (ADR 0133; `findChrome`/`chromeCandidates` in browser.ts).
- **Where**: on the agent's computer = machine running `agentes-runner` (self-host server, any connected Mac/Linux/Windows box, or the Cloud's per-workspace always-on computer). No Browserbase/Steel-style cloud browser (ADR 0040 "connected computers only").
- **Headless by default**; runner launches Chrome itself (own debugging port) then attaches with `--cdp`, because Chrome launched by agent-browser carried `navigator.webdriver`/"HeadlessChrome" markers and Google sign-in/search blocked it (browser.ts comment). On the agent's virtual desktop (ADR 0058) the same Chrome runs **headed** on that display, same profile.
- **Profile**: one persistent `--user-data-dir` per agent in its folder ("a login done once stays"); **never the user's real Chrome profile** (ADR 0133 §1). Named **shared browser profiles** (e.g. one WhatsApp login for 5 agents) granted per agent, one driver at a time via a 2-min "turn" lease (ADR 0110; packages/engine/src/browser/profiles.ts). Chrome's own password manager/sign-in/autofill are off (ADR 0144 §4.6). Cookie encryption uses `--password-store=basic` (Linux) / `--use-mock-keychain` (macOS) → profile cookies effectively protected only by file perms `[INFERENCE from ADR 0133 §2]`.
- **Live view & takeover**: agent-browser's JPEG frame WebSocket relayed as `browser.frame` (q60, ≤1280px, ack-paced) to web/phone; person input relayed (`relayCommands`); full VNC-like desktop view via `rfb.ts` for the desktop (browser.ts; ADR 0040 §7). **`browser_ask_person`** suspends the run, pushes a card/phone notification; first person to open gets "you're in control", page hidden from others, Done/Couldn't (ADR 0040 §6).
- **Logins**: (a) human logs in via handoff; (b) **Vault** login typed by `browser_type_secret`—model never sees value; runner gets a one-use in-memory key (2 min), server seals password to it, runner checks frame origin + ancestors match the item's site rule, refuses GET forms/iframes, pauses requests and blocks any URL containing the value for 2 min, redacts value from replies for 10 min (ADR 0144 §4; apps/server/runner/vault.ts). Sources: built-in, **1Password** service account, **Bitwarden/Vaultwarden** (ADR 0144 §3). (c) `request_secret` with target `site` (in runner memory 15 min). `browser_make_password` creates+saves passwords.
- **Tool surface**: native tools, not MCP: `browser_open/read/do/click/fill/type_secret/back/tabs/screenshot/profile/ask_person/make_password` (packages/engine/src/browser/tools.ts). Page = accessibility-tree text with refs (works with non-vision models); `browser_do` batches plans, plus judge/vision checks (ADR 0054, Status: Proposed—partly built per code refs).
- **Guards**: runner refuses agent-supplied flags that widen reach (`--profile`, `--cdp`, `--extension`, `--proxy`, `--executable-path`, `--allowed-domains`...) (browser.ts L308-358 deny list). **Site allowlist** own implementation (`domainAllowed`): checks navigations before and top-level page after each action; **sub-resources not filtered** (browser.ts comment). Loopback/LAN guard (`loopback-guard.ts`, `browser-bind-policy.ts`). Human-like input (`human-input.ts`) is the only "stealth"; **captchas never solved by agent**—go to a person via handoff (browser.ts comment). Page/vault text wrapped in `untrustedBlock` (ADR 0117 injection hardening).

### 2. Credentials / secrets

- **Org credentials (provider API keys, connector tokens, webhook signing secrets)**: Postgres, **envelope encryption**: random 256-bit data key, **AES-256-GCM**, data key wrapped by `local:v1` KEK = **HKDF from `AGENTES_SECRET`** (self-host) or **KMS module** (Cloud); AAD binds `provider-credential|org|id`; `kek_id` per row for rotation; API returns only last-4 hint (docs/adr/0007-provider-credentials.md).
- **Subscriptions** (Claude Code / Codex logins): only on the agent computer (`~/.claude`, `~/.codex`, runner `token.json` mode 600), never server DB; setup-token passed to Claude Code via FD (SELF_HOSTING.md; apps/server/src/operator/claude-auth.ts). Rationale: Anthropic forbids third parties to "collect, store, or intermediate" Claude.ai creds (ADR 0027 Context).
- **User secrets for the computer** (`request_secret` tool → card): E2E — runner makes per-request keypair; browser encrypts with WebCrypto **ECDH P-256 + HKDF-SHA256 + AES-256-GCM**, AAD `requestId|orgId|name|target`; server relays ciphertext only, stores no value (ADR 0027 §1-3; apps/server/runner/secrets.ts). Targets: `env` (`store.json` mode 600 in `<runner home>/secrets/<agent>/`, injected into child env), `file` (workspace path, 600), `site` (browser-only, memory).
- **Vault** (ADR 0144): items Login/Key/Contact, personal or team (`manage_credentials`, audience by roles/people); built-in sealed with AAD `vault-item|org|item|owner|version`. Keys go into **one command's env** (`run_code` with `keys`), output redacted; routine runs only get keys their creator allowed (amended 2026-11-12).
- **Agent can read them?** Yes for env/file secrets: "The agent has a shell... so it can read a secret it was given. We reduce, not prevent" (ADR 0027 §5). Mitigations: exact-value redaction to `[secret:NAME]` in all outputs (`redactSecrets`), store outside workspace, file tools refuse secret files. ADR 0144 §5 admits a same-user script can read a typed password via Chrome's debugging port. No egress proxy/placeholder substitution (only GitHub git proxy with short-lived App tokens) `[INFERENCE: no proxy found besides git]`.
- **Isolation weakness**: default runner = agents share the runner's OS user ("OS doesn't stop cross-agent access"); `install.sh --system` gives per-agent Linux users, root relays sealed boxes only (vault.ts header; SELF_HOSTING.md). Protected mode (Seatbelt/bubblewrap) only proposed (ADR 0030).
- **Approvals/audit**: Tool Gateway checks `agent_scopes` per call; sensitive tools (merge/deploy/rollback, connector writes, sends) create `approvals` rows with `action_hash`, 24 h expiry, decided by owner/admins (ADR 0015). Per-agent monthly budget checked before every model call (ADR 0007). Audit: `secret.requested/delivered/declined/expired/removed`, every Vault use (who/where/for whom), never values (ADR 0027 §6, 0144 §4.7). Limits: 3 pending requests/run, 50 secrets/computer.
- **Telemetry**: on by default, daily anonymous counts (people, agents, tokens per model, browser bytes) to telemetry.agentes.chat via Cloudflare; `TELEMETRY=off`; `agentes-server telemetry` prints report (SELF_HOSTING.md "Optional services"). Cloud vendor holds KMS-wrapped keys + DB; Composio sees connector data `[INFERENCE]`.

### 3. Crons / scheduling & triggers

- **Implementation**: no cron lib; own dependency-free 5-field cron in IANA tz with DST rules (packages/engine/src/cron.ts `nextCronTime`). Natural language ("toda segunda às 9h", any language) parsed by a model with structured output, validated in code (schedule.ts `readSchedule`/`parseWhen`). Recurring (`schedule`) and one-off (`once`) routines + `schedule_reminder`.
- **Tick**: server worker every **5 s** (`WORKER_INTERVALS_MS.routines`, apps/server/src/workers.ts) calls `fireDueRoutines` (packages/engine/src/routines.ts ~L2059): `FOR UPDATE SKIP LOCKED` + advisory lock + unique `(routine_id, at)`, 0-59 s hash jitter; enqueues `routine.run` in **Postgres outbox** (lease, retries with backoff, `max_attempts` 8; outbox.ts).
- **Missed runs**: server down → next slot computed from now, "runs once, not in a burst" (routines.ts comment). Computer away → run waits, never falls back to API brain; next slot supersedes; >12 h old → `missed`; creator + owner notified once per outage (ADR 0053 §6.4; routine-firing.ts).
- **Overlap**: one run at a time per routine; slot `skipped (previous_running)` or supersedes a run waiting on a person; events during a run merged into the next (routine-firing.ts `makeWayForRun`).
- **Limits/failures**: min interval 15 min for agent-run routines, max 20 active routines/agent; 1st failure notifies, 5 in a row pauses (`failing`); Stop button; ledger statuses reported/silent/failed/canceled/superseded/missed/skipped with run history (last 100) (ADR 0053 §5-6). Budget = agent's monthly budget (ADR 0007). No explicit per-run timeout found `[UNVERIFIED]`; step cap `AGENT_MAX_TOOL_TURNS` + loop detection (ADR 0015).
- **Who creates**: users in Rotinas UI (web/phone) or the agent itself via `create_routine`/`update_routine`/`schedule_action` tools (packages/engine/src/schedule-tools.ts L586-1071); unattended runs can't create routines (ADR 0053 §2).
- **What a run is**: fresh background run in a hidden per-routine "routine room", with brief, last run record and read-only recent messages of the target conversation; reports via `hand_off` to channel/DM (ADR 0053 §4). Access `read` (default, read-only `plan` profile) or `act`.
- **Approvals while away**: connector writes become approval cards that wait (expire 24 h; superseded runs' approvals expire); "approved ahead" own actions via `schedule_action`/`own_actions` pass without a card (ADR 0053 addendum 2026-11-03/05; ADR 0015). Routine runs can't `request_secret`.
- **Other triggers**: email (IMAP poll / Composio Gmail/Outlook), GitHub PR, Sentry issue, deploy, task created, **webhook** (`/api/hooks/<token>`, HMAC token stored as hash, optional signing secret, 60 calls/min/routine, 256 KB) (ADR 0106), **connector events** auto-registered as webhooks (ADR 0130).
- **Host off**: server-side scheduler, so laptop off is fine if server/Cloud is up; runs needing a laptop computer wait/miss as above.

### Sources (deep-dive)

- apps/server/runner/browser.ts, vault.ts, secrets.ts, egress.ts; apps/server/src/workers.ts, telemetry.ts
- packages/engine/src/cron.ts, schedule.ts, schedule-tools.ts, routines.ts, routine-firing.ts, outbox.ts, browser/tools.ts
- docs/adr/0007, 0015, 0027, 0040, 0053, 0054, 0106, 0110, 0130, 0133, 0144; SELF_HOSTING.md

# Follow-up (2026-11-13)

## A. Agent browser

- **Tech**: Vercel Labs' **`agent-browser`** (Rust CLI/daemon, Apache-2.0), talking CDP directly to Chrome. Pinned version, SHA-256 checked, shipped as a Tauri sidecar on macOS or downloaded into `~/.agentes-runner/bin/` (docs/adr/0040-agent-browser.md §1-2). No Playwright. Since ADR 0133 it drives the computer's **Google Chrome stable**. Chrome for Testing was removed, with no fallback; on Linux it's installed from Google's apt repo (docs/adr/0133-agent-browsers-on-google-chrome.md).
- **Built-in tools, not MCP**: agents get the project's own `browser_*` tools. They never get the raw CLI or agent-browser's MCP server, so Stop, the allowlist, secrets and caps hold for any model (ADR 0040 §1). Claude Code/Codex reach them through the runner's MCP bridge (ADR 0053 §2).
- **Where it runs**: on the agent's computer, i.e. whatever machine runs `agentes-runner` (self-hosted server, a connected VM/laptop, or the Cloud workspace computer). It doesn't use a vendor browser cloud.
- **Headless/headed**: headless by default (`--headless=new`, 1280x800). Headed runs on the agent's own desktop: one Xtigervnc X11 desktop per agent on Linux, which people watch/drive over RFB/noVNC (apps/server/runner/browser.ts `HEADLESS_ARGS`/`HEADED_ARGS`; docs/adr/0058-agent-desktop.md).
- **Watch/take over**: yes. JPEG frames come from agent-browser's WebSocket stream, and you can take control from the chat card, the agent page or the phone. `browser_ask_person` hands off for logins/captchas/QR codes and the person hands back with a note (ADR 0040 §6-7 and the 2026-11-03 addendum).
- **Profiles**: each agent has its own persistent `--user-data-dir` in its folder. There are also workspace **browser profiles** (one Chrome per profile on one computer, granted per agent, one driver at a time). Those are single-mode only, so they're unavailable on Cloud/system-mode computers in phase 1 (docs/adr/0110-browser-profiles.md §1-8).
- **Logging in as the user**: not via their real profile. Importing auth from the owner's Chrome (`--auto-connect`, profile reuse) is explicitly turned off, and "the person's own Chrome profile is never read or changed" (ADR 0040 §1; ADR 0133 §1). Logins happen by human takeover, or with a `request_secret` `site` password the browser types (ADR 0027 §4).
- **Anti-bot**: `--disable-blink-features=AutomationControlled`. Headless overrides the user agent so it doesn't say "HeadlessChrome", because Google sign-in refuses that. Headed keeps the real user agent (ADR 0133 §5). Captchas are solved by human takeover; no captcha-solver service was found [UNVERIFIED that none exists]. A `--allowed-domains` site allowlist also exists (ADR 0040).

## B. Credentials and secrets

- **Model API keys**: envelope encryption. A random 256-bit data key encrypts the key with AES-256-GCM, and that data key is wrapped by `local:v1`: an HKDF key derived from `AGENTES_SECRET` (purpose `provider-credentials-kek`). On Cloud a "KMS module" wraps it instead. The AAD binds each row to org and id, the API returns only the last 4 characters, and keys are never sent to the client or logs (docs/adr/0007-provider-credentials.md; packages/adapters/src/keys.ts:4). The Cloud KMS module isn't in the repo [UNVERIFIED which KMS].
- **Connector OAuth tokens** (GitHub, Linear, Sentry, MCP): stored encrypted in Postgres, the same way ("sealed", per ADR 0106 §3 and the privacy policy). **Gmail/Outlook/Google Workspace/Slack go through Composio**, which holds those connections, and data passes through it (SELF_HOSTING.md, Composio row; docs/adr/0038-agent-mailbox-access.md). The operator supplies `COMPOSIO_API_KEY`, so on Cloud the vendor's Composio account holds them [INFERENCE].
- **Claude/Codex subscriptions**: these never go into the server DB. They live on the agent computer: `claude setup-token` token in `token.json` (mode 600, root-only in `--system` mode), passed to Claude Code **on a file descriptor, not env**, so commands it runs don't see it. Codex gets a per-turn copy of its `auth.json` in the agent's folder, which **is** on disk where the agent works. In the default (non-system) install, agents can reach every account folder at the OS level (SELF_HOSTING.md "One sign-in for all of your agents" / "Who can reach an account").
- **Agent secrets (`request_secret`)**: end-to-end. The computer makes an ephemeral P-256 key pair; the browser encrypts with WebCrypto (ECDH+HKDF+AES-256-GCM, AAD bound to request/org/name/target). The server only relays ciphertext and stores no value. Targets are `env` (`~/.agentes/secrets/env` 600), `file` in the workspace, or a `site` password. Output redaction replaces values with `[secret:NAME]`, and file tools refuse to read them. Only the person who started the run can answer, and routine/agent-started runs can't request secrets (docs/adr/0027-secrets-to-agent-computers.md). ADR 0027 admits the agent shell "can read a secret it was given. We reduce, not prevent". There's no call-time broker for env secrets.
- **Browser cookies**: in each agent's Chrome profile on the computer, protected only by Chrome's `--password-store=basic` / `--use-mock-keychain` fixed keys (ADR 0133 §2). In practice that's plaintext-equivalent at rest [INFERENCE].
- **Prompt-injection/exfiltration**:
  - Outside text (web, mail, files, `run_code` output) is wrapped in `<external_data>` envelopes, and hidden HTML and bidi/tag characters are stripped.
  - In runs that read outside text, `remember` refuses addresses no person wrote.
  - Outbound URL checks (`packages/adapters/src/outbound-url.ts`, `packages/engine/src/outbound.ts`): a URL must already have been seen, and credential shapes (`sk-`, `ghp_`, `xox*`...) are blocked.
  - MCP tool descriptions are re-reviewed when they change, and the checkout's `.claude/settings.json` is not loaded (docs/adr/0117-injection-hardening.md).
- **Approvals/scoping**:
  - Merge/deploy/rollback and connector-sensitive actions need an approval card. Mail send asks by default.
  - A policy table (`tools/run-policy.ts`) is enforced at tool listing and at every call, by authority (person/routine/unattended).
  - Routine runs default to read-only, and Claude Code gets a `plan` (read-only) profile in those runs.
  - Scopes are per agent per connector (docs/adr/0053-routines-unattended-work.md §1-3; README).
- **Audit**: audited events are referenced throughout (e.g. `sandbox.recreated`, secret lifecycle in ADR 0027 §6), plus an operator events feed (docs/adr/0056 §5). I didn't trace the exact audit table [UNVERIFIED].

## C. Crons / scheduling

- **"Routines"** trigger types: `schedule` (a natural-language phrase plus a derived 5-field cron and/or a structured rule, with an IANA timezone), `once` (reminders), `event` (GitHub PR, Sentry issue, new task, deploy...), `email` (new mail via Composio triggers, or IMAP polling), and `webhook` (per-routine URL `/api/hooks/<token>`, optional HMAC signature, 60 calls/min). Connector events are registered as webhooks through the connection (packages/engine/src/routines.ts:185-210; docs/adr/0106-routines-by-webhook.md; docs/adr/0130-connector-events-as-routine-triggers.md).
- **Firing component**: the in-house, dependency-free cron evaluator `packages/engine/src/cron.ts`, which handles DST (a skipped hour moves forward, a repeated hour runs once). Jobs go through the **Postgres `outbox` table**, which is both transactional outbox and job queue. Workers claim rows with `FOR UPDATE SKIP LOCKED` and leases, poll every second inside the server process, retry with backoff from 5 s to 3 h, and are safe across several replicas. There is no Redis or pg-boss (docs/adr/0005-postgres-outbox.md). State lives in Postgres.
- **Timezone**: defaults to the creator's zone, then the org's, then UTC (routines.ts:357).
- **Missed runs**:
  - One run at a time per routine; an overlapping slot is `skipped` or `superseded`.
  - If the agent computer is away, the run waits (no API-brain fallback), and the newest slot supersedes the older one.
  - A slot older than 12 h when the computer returns is `missed` (`ROUTINE_CATCH_UP_MS = 12 * 3600_000`, packages/engine/src/routine-state.ts:28). Runs waiting on a plan or budget reset can be missed the same way.
  - Webhook calls that arrive while a routine is paused are not replayed (ADR 0053 §6; ADR 0106).
  - What happens to schedule slots while the _server itself_ was down: I didn't trace this [UNVERIFIED], but this catch-up logic implies the newest slot runs within 12 h [INFERENCE].
- **Limits/cost**: at most one run every 15 minutes per routine (except reminders), 20 active routines per agent, and event dedupe keys. After 5 failures in a row a routine auto-pauses. Its runs are paused once they start 10 follow-on runs nobody asked for ("stretch"). The agent's monthly budget is checked before every model call, and run history/health counts are kept (ADR 0053 §6; ADR 0007; routines.ts:334).
- **Agent-created schedules**: yes. The `create_routine`/`update_routine` tools accept schedule/webhook triggers, but a routine run can never create or modify routines (ADR 0053 §2; ADR 0106 §10).
- **Laptop off**: the scheduler is the server (self-hosted VPS or Cloud), and execution happens on the agent computer. Both have to be up. For laptop-off operation, use the default topology (the server is also the agents' computer) or Cloud's always-on workspace computer.

## D. Stack scope clarification

- **(1) Self-hosted/open source**: every stack item in §7 was verified from repo files (package.json, Dockerfile, docker-compose.yml, apps/_, packages/_, ADRs).
- **(2) Hosted Cloud**:
  - The vendor says Cloud runs "this same codebase" / "the same image" (README; Dockerfile header "agentes.chat Cloud runs the same image"; site "The same image as the cloud").
  - deploy/deploy.sh is a Docker Compose deploy on a server, run over SSH, pulling `ghcr.io/agentes-chat/agentes:edge` or building from main. It has a `MACHINE_PROVISIONING=external` mode "(agentes.chat Cloud)" that requires S3 storage.
- **Closed parts of the Cloud**:
  - The per-workspace computers come from an **external provisioner the operator runs**, outside the repo, via the Operator API (docs/adr/0056-operator-api-and-external-provisioning.md §10). ADR 0002 rules out private modules in the server process.
  - The Cloud key wrapper is a "KMS module" that isn't in the repo.
  - So it's the same server code, plus private services around it (provisioner, KMS, ops) [INFERENCE from ADR 0056/0007].
- **Cloud provider**: not published. Response headers on agentes.chat show `server: cloudflare` and `via: 1.1 Caddy`, i.e. Cloudflare in front of Caddy, matching the compose `https` profile. ADR 0133 says Cloud computers run in the EU and on Linux. The privacy policy names no specific subprocessors or hosting provider (https://agentes.chat/privacy.md). Hetzner/AWS etc. [UNVERIFIED].

## E. Sandbox / agent computer: what it is used for

### 1. What the computer is

- **The computer**: any machine running `agentes-runner`, connected over WebSocket. The three shapes are: the self-hosted server itself (the default), a server/VM/laptop you pair, or on Cloud "each workspace gets a computer of its own, always on" (README; docs/adr/0077-connected-computers-only.md). Per-agent Daytona containers were removed on 2026-10-28 (ADR 0077).
- **Granularity**: one computer per workspace, shared by many agents. Inside it:
  - Default mode: each agent gets a folder (`<handle>-<id8>`) and all agents run as the runner's OS user.
  - `--system` mode (every Cloud computer, per ADR 0110 §8): each agent is its own Linux user with its own home (0700), systemd slice, `/tmp`, browser profile and sign-ins. Each agent can reach only its own local ports (SELF_HOSTING.md "What an agent reaches on its computer"; docs/adr/0175-the-right-hands-computer.md §1).
  - The workspace helper "Lodi" additionally gets a seat per person plus a shared one (ADR 0175).
- **Lifecycle**:
  - The disk and home are persistent.
  - A Cloud workspace computer can be put in standby by the operator and is woken on demand (a run's first turn, or someone opening the screen view) (docs/adr/0161-computers-that-sleep.md §1-2).
  - After a restart or move, what was open (terminals, apps, Chrome) reopens (docs/adr/0168-a-computer-comes-back-as-it-was.md).
  - Desktops stay on once started and are parked only when memory runs short (ADR 0058, amended by 0065).
- **What's on it**:
  - Shell and file tools, plus git (clones fetched from GitHub with a 1-hour read-only token, pushes through the server's git proxy) (SELF_HOSTING.md §Agent computers; ADR 0024).
  - Google Chrome + `agent-browser` (§A).
  - A per-agent X11 desktop (Xtigervnc). People watch and take over over noVNC/RFB, and can open a terminal (docs/adr/0058-agent-desktop.md).
  - GUI computer-use of desktop apps via the accessibility tree plus screenshots (`python3-gi`, `xdotool`, `scrot`, `at-spi2-core`), for "apps with no API or web version" (SELF_HOSTING.md ~l.1405).
  - The Claude Code / Codex / Gemini (Antigravity) CLIs as "computer brains".
  - `agentes-runner doctor` lists "agent apps, toolchains, phones" (SELF_HOSTING.md l.363). The exact preinstalled toolchains on Cloud (python/node/ffmpeg/pandoc) aren't documented [UNVERIFIED].
- **Capabilities**: run commands and code (`run_code`, `run_skill_script`), read/write files, git clone/branch/PR, run dev servers / test DBs / Gradle on per-agent ports (SELF_HOSTING.md l.1313-1316), drive the browser headless or headed, drive the GUI desktop, receive secrets (`request_secret`), and call a local Ollama or DB once you allow it (`agentes-runner services allow tcp/11434`).
- **Main loop or tool target?** Both:
  - With an API key, the agent loop runs **on the server** (Model Gateway, ADR 0007) and the computer is a tool target.
  - With a Claude/Codex plan, the CLI on the computer **is** the brain ("The executor on the machine is the brain. Our side is the interface and the guard", docs/adr/0029-missions.md). Our tools reach it through an MCP bridge (ADR 0053 §2).
  - Background routine runs "never fall back to the API brain"; they wait for the computer (ADR 0053 §6.4).

### 2. Use cases the project itself shows

Sources: the team templates in packages/engine/src/team-templates.ts (role, default cron, skill) with English text in packages/i18n/src/en.ts `teamTemplates`, plus the site, README and ADRs.

| #   | Use case (source)                                                                                                                                                                                                                                               | Computer needed?                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **Dev "Ada"**: "Fixes the bugs customers report and opens the PR"; daily 09:00 routine "List the new bugs"; `review` skill (team-templates.ts; en.ts)                                                                                                           | Yes: clone, edit, test, push branch [INFERENCE from git tooling]               |
| 2   | Engineering on the site: "The alert came in at 2:02pm. Fixed by 2:09pm… Without opening the laptop" (https://agentes.chat/); README routine triggers include "a Sentry issue"                                                                                   | Yes (code fix); trigger is a Sentry webhook                                    |
| 3   | Task board: "A task given to an agent moves on its own as the agent starts and opens a pull request" (README); missions = long work driven by the executor on the computer, each round ending in "screens, diff, preview" (docs/adr/0029-missions.md §1)        | Yes                                                                            |
| 4   | **Customer service "Iara"**: "Answers customers on WhatsApp and email. Calls you when she doesn't know"; daily "Sum up what was left unanswered" (en.ts)                                                                                                        | Mostly no: WhatsApp Business/Gmail via Composio, IMAP [INFERENCE]              |
| 5   | **Billing "Caio"**: "Reminds whoever is late on payment and sends the reminder after your ok"; Mon 08:00 "List who is late on payment"; `dunning` skill; site: "Every morning, yesterday's invoices already checked"                                            | No: connectors (Stripe etc.) plus approval                                     |
| 6   | **Content "Lia"**: "Writes posts… and schedules them after your ok"; Mon 10:00 "Propose the week's posts" (en.ts)                                                                                                                                               | No (social connectors, ADR 0170)                                               |
| 7   | **Sales "Theo"**: follows up quote requests and writes proposals, daily 17:00 (en.ts)                                                                                                                                                                           | No / Drive artifacts                                                           |
| 8   | **Orders "Otto"**: "Follows orders and stock and warns what is running out", daily 08:00 (en.ts)                                                                                                                                                                | No, unless the store has no API, in which case it uses the browser [INFERENCE] |
| 9   | **Scheduling "Nina"** / personal **"Clara"**: book, confirm and move appointments and remind clients the day before; "Send today's agenda" at 07:00 (en.ts)                                                                                                     | No (Calendar via Composio)                                                     |
| 10  | Browser: "web apps without an API, test logins, Stripe test checkouts, checking a UI the agent just built" (docs/adr/0040-agent-browser.md Context); ADR 0110: "a routine… 'every 5 minutes, answer the shop's chats' opens [the browser profile] when it runs" | Yes (browser)                                                                  |
| 11  | Desktop computer-use: "open an app, click, type and read the screen, for apps with no API or web version" (SELF_HOSTING.md)                                                                                                                                     | Yes (GUI desktop)                                                              |
| 12  | Postgres connector: read-only SQL with time/row caps (README)                                                                                                                                                                                                   | No                                                                             |

Templates come as bundles: Life in order, Health, Studies, Home, Travel, Freelance, Marketing agency, Online store, Clinic ("Bookings on WhatsApp"), Software and apps, Customer service, Services office (en.ts `teamTemplates`). Most template roles are connector/API work, and the computer matters mainly for the dev, browser and desktop cases [INFERENCE].

### 3. End-to-end flows

**Flow 1: bug → PR → approved merge (person present, with approval)** [INFERENCE composed from README, ADR 0029/0053/0015, ADR 0030 level 1]

1. A person posts a bug in a channel or assigns a board task to Dev Ada. The router picks Ada without an @mention (README Router).
2. Claude Code runs on the workspace computer under Ada's plan sign-in, in Ada's folder or a mission worktree. It clones (with a 1-hour GitHub App token), edits, runs tests or a dev server, and pushes to the `agentes/<handle>/*` branch only (ADR 0030 L1; ADR 0044).
3. The task card moves by itself, and the thread shows diff, screens and preview (README Tasks; ADR 0029).
4. The merge is an **approval card** for the agent's owner or an admin. "The approved action runs once, exactly as approved" (README Approvals).

**Flow 2: user absent, scheduled/event routine** (README Routines; ADR 0053 §6; ADR 0106)

1. Billing Caio's routine fires at `0 8 * * 1` in the creator's timezone, or a Sentry issue / signed webhook fires an event routine. The Postgres outbox worker claims it.
2. The run checks the budget, reads connectors, and works on the computer if it needs to. If the computer is off, it waits, and a slot more than 12 h stale is `missed`.
3. Writes to connected apps and mail sends become **queued approval cards**, and the report goes to the channel/DM/Drive with a push to the phone app (README Notifications; ADR 0053 §2).
4. The person approves from the phone later, and the approved call runs once.

**Flow 3: browser hand-off / human takeover** (docs/adr/0040-agent-browser.md §6-7 and the 2026-11-03 addendum; ADR 0027 §4)

1. The agent opens a site in its own Chrome profile on the computer and reaches a login, captcha or QR code.
2. It calls `browser_ask_person`, and a live JPEG view card appears in the chat (web, desktop app or phone).
3. The person takes control, signs in (cookies persist in the agent's profile), then hands back with a note. Alternatively the agent asks for a `site` secret via `request_secret`, encrypted end to end, and the browser types it.
4. The agent continues. The page is hidden from others while a person is in control.

### 4. File/data flow

- **In**: chat uploads and the Drive (versioned; disk, Postgres or S3/the org's own bucket, per docs/adr/0019-file-storage-and-artifacts.md); `push_file` to the computer (ADR 0025); git clone; secrets via `request_secret`; a per-computer **shared folder** `/srv/agentes/shared` (system mode, group `agentes-shared`) or `<workspace>/shared` (docs/adr/README.md, 0115).
- **Out**: `upload_file`/`export_file` to Drive or chat; **artifacts** (Markdown document, table/CSV, diff/patch, self-contained HTML in a sandboxed separate-origin iframe with no network, Mermaid diagram) (ADR 0019); git push through the server proxy and then a PR; Word/PDF export of documents (README Drive).
- **User's local files**: only if the user pairs their own laptop/Mac as a computer. The desktop app can let agents work on "that Mac or Linux computer, after the app asks" (README). A `request_folder_access` tool exists (ADR 0053 §2 list) [UNVERIFIED details]. The Cloud computer can't see local files.
- **Egress**: the computer has its own network. The old per-org allowlist died with Daytona (ADR 0077 §1). `--system` blocks agents from other agents' ports, host services, and container/VM networks (SELF_HOSTING.md). An optional admin `networkLauncher` sets a per-agent network context, and Cloud computers report their egress IP and country (docs/adr/0101). Policy checks on outgoing URLs and credentials still apply (ADR 0117).

### 5. Limits / caveats

- On Cloud there's no per-hour compute cost: the computer is part of the plan, and Daytona's per-vCPU-hour metering was removed (ADR 0077 §1). Sizes are only "a computer / a bigger cloud computer" with 50/200/500 GB of files (site pricing). CPU/RAM/GPU aren't published; no GPU found [UNVERIFIED].
- Self-host sizing is "not measured yet". The server uses `mem_limit` 8g by default (docker-compose.yml). The `--system` agent computer needs Linux root, systemd with `BPF_FRAMEWORK` and ≥4 GB (SELF_HOSTING.md l.291-293).
- Isolation gap in default mode: agents share one OS user and can reach each other's folders and sign-ins; the OS sandbox (Seatbelt/bubblewrap) is only Proposed (ADR 0030). Workspace browser profiles are unavailable on Cloud (ADR 0110 §8). Codex is "still in testing" (README).
- The computer is shared per workspace: there are browser caps per computer (ADR 0110 Consequences), at most two concurrent clones per computer (SELF_HOSTING.md l.1155), and a run may wait "for room on a computer" (ADR 0056 analytics). A routine fires at most every 15 minutes, with one run at a time (ADR 0053 §6).
- Background work fails over to nothing: no computer means waiting or `missed`, with no API fallback (ADR 0053 §6.4).

## F. Scenario: nightly scrape to CSV on ChatGPT subscription, laptop off

### 1. Verdict

**Partly: works by design, but with caveats.** It works only if the agent's computer is an always-on host: either agentes.chat Cloud (the Personal plan's "cloud computer that's always on", $29/mo) or a self-hosted Linux VPS that is both server and agents' computer. It does **not** work if the paired computer is the laptop itself: background runs wait for the computer, and a slot more than 12 h stale is `missed` (ADR 0053 §6.4; packages/engine/src/routine-state.ts:28).

Caveats:

- Codex is "still in testing" (README).
- No doc shows a worked example of a scheduled Codex-subscription run. There is design-level evidence that routines use the agent's own brain, Codex included: "a routine thinks with its agent's own brain (Claude Code, Codex or the API), never forced onto the API" (docs/adr/0053-routines-unattended-work.md), and "Background runs never fall back to the API brain" (§6.4). The end-to-end path is [UNVERIFIED in practice].

### 2. How the ChatGPT login reaches the always-on host

- **Model caller**: the **Codex CLI on the agent computer** (`codex exec --json …` or a long-lived `codex app-server`), spawned by `agentes-runner` (apps/server/runner/brain-codex.ts header). The server doesn't call OpenAI for this; the CLI is the brain, and the product's tools (browser, files, Drive) reach it via an MCP bridge (`CODEX_MCP_SERVER`, ADR 0053 §2).
- **Sign-in**: done from the app, **Settings → AI and usage**. The runner runs `codex login --device-auth` in a fresh account folder (`<runner home>/accounts/codex/<id>`, mode 700, used as `CODEX_HOME`) and shows the device URL and one-time code. The user approves on OpenAI's page from any device, so nothing listens on the computer. `codex login status` confirms the email and plan (apps/server/runner/accounts.ts:85-100, :178). There's no upload of the laptop's `~/.codex/auth.json`; it's a fresh, separate device login [INFERENCE: so the laptop session is independent].
- **Storage**: `auth.json` lives in that account folder on the computer, never in the server DB (SELF_HOSTING.md). With `--system` (Cloud), a sign-in shared by all agents is root's `auth.json`, copied to the agent's folder for each turn, and refreshed copies are watched back (`codex_auth` grant, `watchCodexAuth`, accounts.ts:423).
- **Refresh unattended**: the Codex CLI itself refreshes the token (after 8 days; the access token lasts 10, per `CODEX_REFRESH_AFTER_MS`, accounts.ts:451-452). The runner serializes CLIs on one sign-in because "two processes on one sign-in race on its refresh token" (accounts.ts:380). If the sign-in is refused, the turn fails with `not_logged_in` (docs/adr/0041-claude-accounts-per-agent.md:67).
- **Plan limit at 3am**: "When an account runs out of plan, the agent says so and waits, or uses the model fallback. It never moves to another account" (ADR 0041:95). A routine waiting past the plan reset is `waiting_plan` / `waiting_plan_late` → "Missed: the plan reset too late" (routine-state.ts:44,48). A model fallback needs an API key configured [INFERENCE].
- **Unattended allowed?** Yes, by design (ADR 0053 above). In routine runs Codex gets the `work` profile when the routine may act, with `approvalPolicy: never`. Its own sandbox has **no network** ("never with the network", brain-codex.ts header), so web access must go through the product's `browser_*` / `web_fetch` tools over the MCP bridge [INFERENCE].

### 3. Setup UX (cheapest path: Cloud Personal $29/mo; or free self-host on a VPS you pay for) [INFERENCE composed from cited pieces]

1. Sign up at agentes.chat and pick Personal. The workspace computer gets provisioned ("My computer is starting up", en.ts `teamTemplates.hello`). Self-host alternative: `curl -fsSL https://agentes.chat/install | sh` on a VPS, answering yes to "this server as the agents' computer" (SELF_HOSTING.md quick start).
2. Settings → AI and usage → connect ChatGPT: device code as above. Then set the agent's "Who thinks" to that account (SELF_HOSTING.md).
3. Create the routine in **Rotinas** or by asking the agent in chat (`create_routine` accepts a schedule). A schedule is a natural-language phrase ("every weekday at 9am", README), stored with a derived cron and an IANA timezone that defaults to the creator's, then the org's, then UTC (routines.ts:196, :357). It fires at most every 15 min, and you choose the delivery target (channel/DM/Drive).
4. Site login: ask the agent to open the site, then **take over** the live browser and sign in yourself. Cookies persist in the agent's Chrome profile (ADR 0040 §6; ADR 0133 §2). Alternatively `request_secret` with target `site`, but a routine run **cannot** request secrets (ADR 0027 §2), so it has to be done in a person-started run beforehand.
5. Test: Stop/run controls exist, and `run_routine_now` is a tool (ADR 0053 §2 list). A "run now" button in the UI [UNVERIFIED].
6. Approvals at night: writing a file in the Drive is an internal, undoable change and is allowed for routines (ADR 0053 §2 `act`; ADR 0109 made every routine act). Only connected-app writes, mail sends and merge/deploy wait on an approval card. So scrape→CSV→Drive needs **no human at 3am** [INFERENCE].

### 4. What happens at night

- The in-process cron evaluator (packages/engine/src/cron.ts) fires, and a job lands in the Postgres `outbox`. The server worker claims it with `FOR UPDATE SKIP LOCKED` (ADR 0005) and checks the agent's budget (ADR 0007).
- **Waking**: a Cloud computer in standby is woken by the run's first turn (`wantMachine` reason `run`, docs/adr/0161-computers-that-sleep.md §2).
- The runner starts a Codex turn in the agent's folder. The agent drives Chrome through `browser_*` tools (headless, persistent profile). The CSV is produced with shell/`run_code` (python/whatever is installed, [UNVERIFIED] which interpreters) or a `table` artifact with CSV export (ADR 0019), then saved with `upload_file`/`export_file` to the Drive (disk/Postgres/S3).
- **Failures**:
  - Captcha or expired login: `browser_ask_person` is meant for a person who is present. For routine runs, what it does is [UNVERIFIED]; likely it hands off or reports [INFERENCE].
  - A failed run notifies the creator. 5 failures in a row auto-pause the routine.
  - One run at a time; a slot is skipped if the previous run is still going. Outbox jobs retry with backoff from 5 s to 3 h (ADR 0053 §6; ADR 0005).
  - A computer away for more than 12 h → `missed`, with one notification per outage.

### 5. Morning UX

- The report posts in the chosen channel/DM, or files go to the Drive, with a push notification to the phone app (README Routines/Notifications). The CSV is downloadable from the Drive or the chat attachment. Rotinas shows run history and health counts (ok/silent/failed/skipped/missed, routines.ts:334), and the routine can be re-run with `run_routine_now`. Email/Telegram delivery of the file isn't documented for routines [UNVERIFIED]; Gmail sends would need approval.

### 6. Cost

- Cloud Personal is **$29/mo** ($288/yr), with the computer included and no per-hour metering (ADR 0077 removed vCPU-hour billing). Self-host is $0 plus your VPS: 2 vCPU/4 GB suggested, and the `--system` agent computer needs ≥4 GB (SELF_HOSTING.md).
- Model usage counts on the user's ChatGPT plan ("AI usage is never on our bill", site). Usage is recorded per agent; a subscription turn likely costs $0 against the budget [UNVERIFIED].

### 7. Gotchas

- **Laptop as the computer = silent `missed` runs** (no API fallback). Use Cloud or a VPS computer.
- Codex is "still in testing" (README). Codex's own sandbox has no network, so the scrape must use the product's browser/web tools.
- Captchas or bot walls at 3am need a human. Anti-bot measures are minimal (§A).
- A routine can't request secrets, so the login must be prepared in an interactive session. Cookie expiry then breaks the nightly run.
- Plan limits make the run wait; it's missed if the reset comes too late. ChatGPT usage is shared with the user's interactive Codex use on the laptop. A separate device login avoids refresh-token clashes with the laptop's `~/.codex` [INFERENCE].
- Personal plan = 1 user. The routine cap is 20 per agent, and Cloud computers run in the EU (exit IP visible, ADR 0101/0133), so geo-restricted sites may block it.

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

(This restructured version supersedes the earlier "nightly scrape to CSV" section above; the citations are the same.)

### F1. Verdict

- **Hosted (agentes.chat Cloud, Personal $29/mo): Partially/likely yes.** Cloud gives each workspace an always-on computer running the same runner. The ChatGPT sign-in is made _on that computer_ by device code, and routines use the agent's own brain (Codex included) with no API fallback (README; ADR 0077; ADR 0053). There are two reasons it's only "partially":
  - Codex is "still in testing" (README).
  - No doc or test shows a worked 3am Codex routine end to end [UNVERIFIED in practice].
- **Self-hosted VPS: Partially/likely yes, same mechanism**, provided the VPS is also the agents' computer (the installer's default) (SELF_HOSTING.md). **No** if the only computer is the laptop: runs wait and are `missed` after 12 h (packages/engine/src/routine-state.ts:28).

### F2. The ChatGPT-subscription crux

- **Hosted, laptop off: yes.**
  - Nothing relays through the laptop. The Codex CLI runs on the Cloud workspace computer, spawned by `agentes-runner` (apps/server/runner/brain-codex.ts).
  - Sign-in is device code in the web app: the runner runs `codex login --device-auth` in `<runner home>/accounts/codex/<id>` (mode 700, used as `CODEX_HOME`) and the app shows the URL and one-time code; the user approves on OpenAI's page from any device (apps/server/runner/accounts.ts:85-100, :178).
  - No upload or paste of `~/.codex/auth.json` was found.
- **Storage**: the token is in `auth.json` on the Cloud computer, never in the server DB. In system mode (Cloud) a sign-in shared by all agents is root's `auth.json`, copied per turn, and refreshed copies are watched back (accounts.ts:423; SELF_HOSTING.md "One sign-in for all of your agents").
- **Unattended refresh**: the Codex CLI refreshes the token itself (refresh after 8 days; the access token lasts about 10, per `CODEX_REFRESH_AFTER_MS`, accounts.ts:451). The runner serializes processes on one sign-in to avoid refresh-token races (accounts.ts:380).
  - A refused sign-in means the turn fails `not_logged_in` and the runner re-checks (ADR 0041:67). A re-login prompt has to be handled by a human [INFERENCE].
  - Plan exhausted: "the agent says so and waits, or uses the model fallback"; a routine is missed if the reset comes too late (ADR 0041:95; routine-state.ts:44,48).
- **Who calls OpenAI**: the vendor's Cloud computer, from an EU datacenter IP (ADR 0133 §5 mentions Cloud computers in the EU; ADR 0101 egress IP). The project documents no ToS position on Codex-from-cloud. It only warns against rotating accounts to evade limits (ADR 0041:95) [UNVERIFIED: OpenAI's stance].
- **Vendor credits**: none. "AI usage is never on our bill. Your agents use your own AI plan or keys" (https://agentes.chat/). No Cloud-only restriction on subscriptions was found: `SHARED_SIGN_INS = { claude_code, codex, antigravity, key: true }` (packages/providers/src/plans.ts; packages/client/test/no-ai-lib.test.ts:586). The only plan-only-on-self-host note concerns the _router_ ("the author's own plan (on a server you run yourself)", README Router), not agents.

### F3. Setup UX on Cloud (composed from docs) [INFERENCE where noted]

1. Sign up at agentes.chat → Personal ($29/mo). Onboarding offers team templates; the computer provisions ("My computer is starting up", packages/i18n/src/en.ts `teamTemplates.hello`).
2. **Settings → AI and usage → ChatGPT** sign-in (device code) → set the agent's **Who thinks** to it (SELF_HOSTING.md).
3. In the agent's DM, ask it to make the nightly job, or use the **Rotinas** form. Schedule: natural-language phrase plus derived cron, IANA timezone defaulting to creator → org → UTC. Deliver to a channel/DM/Drive (packages/engine/src/routines.ts:185-210, :357; README Routines).
4. **Human step, site login**: the agent opens site X in its browser and calls `browser_ask_person`; you take over the live view and sign in, including 2FA and captchas. Cookies persist in the agent's Chrome profile (ADR 0040 §6; ADR 0133 §2). This must happen in a person-started run, because routine runs can't `request_secret` (ADR 0027 §2).
5. Test: `run_routine_now` (tool; ADR 0053 §2). A UI button [UNVERIFIED]. Watch the run live.
6. Approvals: CSV to the Drive is an internal change that routines may make without a card (ADR 0053 §2, ADR 0109). Emailing it or posting it to an outside app becomes an approval card, which would wait for the morning.

### F4. Execution at 03:00

- **Fire**: the in-process cron evaluator (packages/engine/src/cron.ts) produces a Postgres `outbox` job, and a server worker claims it with `FOR UPDATE SKIP LOCKED` (docs/adr/0005-postgres-outbox.md). Budget check (ADR 0007).
- **Wake**: a Cloud computer in standby is woken by the run (`wantMachine` reason `run`, docs/adr/0161-computers-that-sleep.md §2).
- **Scrape**: `browser_*` tools drive headless Google Chrome via `agent-browser` with the persistent per-agent profile, so JS-rendered pages work. Codex's own sandbox has no network, so web access goes through the product's tools over the MCP bridge (brain-codex.ts header; ADR 0053 §2). `web_fetch` is a 10 s / 2 MB GET for public pages (ADR 0109 §2).
- **CSV**: written via shell/`run_code` in the agent folder, or as a `table` artifact with CSV export, then `upload_file` to the Drive. Files are versioned in S3 on Cloud, since deploy.sh requires S3 with external provisioning (ADR 0019; deploy/deploy.sh). The agent folder persists too (ADR 0168).
- **Failure**: failure notifications go to the creator; 5 in a row pause the routine; one run at a time. If the computer is away the run waits, and a 12 h-stale slot is `missed`. Plan limit → `waiting_plan`. Token refused → `not_logged_in` (ADR 0053 §6; ADR 0041). Outbox job retry backoff is 5 s → 3 h (ADR 0005).
- **Captcha or expired cookies at 3am**: a human is needed. What `browser_ask_person` does in an unattended run [UNVERIFIED].

### F5. Getting the CSV out

- Drive download, or an attachment in the report post in the channel/DM, plus a phone push (README Drive/Routines/Notifications).
- Email via a connected mailbox (Gmail via Composio, or IMAP/SMTP) asks for approval by default (README Agent mailboxes), so it isn't automatic at 3am unless allowed.
- Slack/Drive/Sheets via Composio connectors count as outside writes, so approval cards; routine policy amended 2026-10-31 [UNVERIFIED for Composio writes].
- Git push to the agent's own branch is allowed (ADR 0053 §2 `act`). No shared-folder sync back to the laptop (the shared folder is on the computer, ADR 0115). An operator API exists but is admin-only (ADR 0056).

### F6. Gaps and risks

- **Cost**: Cloud $29/mo with compute included; per-hour metering was removed (ADR 0077). Model tokens come out of the user's ChatGPT plan, so nothing is charged by agentes.chat. The nightly run consumes no credits [INFERENCE from the pricing text].
- **Maturity**: Codex is in testing, and the product went public on 2026-11-09.
- **ToS**: the ChatGPT session is used from the vendor's EU cloud IP, and the project says nothing about OpenAI's rules for this [UNVERIFIED].
- **Bot-blocking**: headless Chrome with minimal stealth (an `AutomationControlled` flag off, a user-agent fix), on a datacenter IP. Sites that need a captcha each night, or whose session cookies expire, fail without a human.
- **Silent-ish failures**: plan limits (shared with the user's daytime Codex use), `not_logged_in`, and a missed slot are all reported as notifications, but no output arrives that night.
