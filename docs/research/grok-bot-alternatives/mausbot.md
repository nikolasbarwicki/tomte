# MausBot (OpenMausBot) research (2026-11-13)

## What it is

- "Open source Grok Bot alternative": a desktop chat app (Telegram-style roster) where each "bot" is a real agent (Claude Code / Codex / Grok CLI under the hood) with its own persona, model, cloud computer and connected apps (README; mausbot.com). Also known as OpenMausBot, formerly OpenGrokBot (README, site JSON-LD).
- Repo: https://github.com/milind-soni/OpenMausBot — Apache-2.0 core, `enterprise/` folder source-available under "OpenMausBot Enterprise License" (LICENSING.md). 22,133 stars, last push 2026-11-13 (GitHub API, seen 2026-11-13); version 0.1.155 (package.json). Release binaries in milind-soni/openmausbot-releases.
- Company: Supamaus Software Private Limited; founders Milind Soni and Omkar Satpute (mausbot.com/pro footer & JSON-LD). Claims Google for Startups, NVIDIA Inception, Claude for Startups membership (homepage).

## Infra / self-hosting / laptop-off behavior

- Default: Electron desktop app (macOS arm/Intel, Windows x64, Ubuntu 24.04 .deb/AppImage) with an embedded harness server on `127.0.0.1:8799` that spawns and owns all agent CLI processes; UI talks HTTP + SSE (README "How it works").
- Data: transcripts, keys, events in `~/.openmausbot`; per-thread NDJSON event logs; SQLite via `node:sqlite` (README; grep of server/*.ts). Desktop secrets encrypted with OS store (Keychain/DPAPI/libsecret) in `credentials.bin`, but CLI-entered keys, MCP header values and `mcp-oauth.json` stay plaintext in `config.json` (docs/cli-onboarding.md:82).
- Laptop off: free local app stops when the machine is off [INFERENCE from local-only architecture]. Always-on is via (a) paid **MausBot Cloud** — "your own cloud machine runs your bots 24/7… automations run… even with your laptop off" (mausbot.com/pro), or (b) self-host the server on a VPS: `deploy/install.sh` (`curl … | sudo sh -s -- --domain maus.example.com`), installs Docker images + Caddy HTTPS, pairs to desktop with a one-time code; also `deploy/docker-compose.yml`, `deploy/fly/fly.toml`, `deploy/podman`, `docs/deploy-vps.md`.
- Automations: schedule, webhook, or app events (Gmail, Slack, HubSpot, Stripe); "Gmail is checked every 15 minutes, other apps within seconds" (homepage, /pro).
- Code-execution isolation: per-bot "computer" = cloud Linux desktop from Boat (boat.dev, sponsor), an isolated Local VM, a hardened Cua container on your own VPS reached over Docker-over-SSH (docs/byo-vps.md), or opt-in host control (macOS, Ubuntu Xorg; Wayland disabled). Permission broker turns shell commands/file edits into Allow/Deny cards (README).
- Hosted control plane: Cloudflare Worker with D1 (`cloudflare/control-plane/wrangler.jsonc`) and a Composio broker Worker (`cloudflare/composio-broker`).

## Claude / Codex subscription use

- Yes, primary mode: "Bots run on the claude, codex, and grok CLIs already installed on your computer, using your logins and your subscriptions, with no proxy in the middle" (homepage, README).
- Mechanism: Claude driver spawns `claude` CLI in stream-JSON mode (server/drivers/claude.ts); supports named Claude accounts handling `CLAUDE_CODE_OAUTH_TOKEN`/refresh token env (claude.ts:75-85). Codex driver uses `codex app-server` JSON-RPC, with device-auth sign-in (server/drivers/codex.ts, codex-device-auth.ts). Grok Build via ACP. Onboarding "engine check" installs/signs in Claude Code or Codex (homepage).
- On Cloud: "Sign in to Claude or ChatGPT on your Cloud, or add an API key"; Cloud does not include AI usage (/pro).
- Other engines/keys: xAI, OpenAI, Anthropic API keys; Kimi in picker (homepage); Antigravity, OpenCode Go, custom engine binaries (server/drivers/antigravity*.ts, docs/opencode-go.md, docs/custom-engines.md); OpenRouter / Cloudflare Workers AI for routing model (README); ModelGo inference sponsor. API-key connections "currently support chat only"; agent tools need Codex/Claude Code (docs/cli-onboarding.md:32).
- ToS/ban risk: no explicit warning found; docs only note subscription ≠ API billing (cli-onboarding.md:32) [searched docs/*.md].

## MCPs / apps / integrations

- MCP client: Plugins → MCP servers → Add server; accepts URL (Streamable HTTP/SSE), `claude mcp add` commands, npx/uvx/docker lines, `mcpServers` JSON; MCP OAuth stored in `mcp-oauth.json` (docs/custom-mcp-servers.md).
- MCP server: stdio MCP server (`pnpm mcp`, scripts/mcp-server.ts) for Claude Desktop/Cursor to orchestrate bots; excludes approvals, deletion, credentials (README, docs/mcp-server.md). Also headless `openmausbot` CLI for scripts/CI.
- Apps: Gmail, Slack, GitHub, Notion, Linear, "500+" via **Composio Sessions** — one-click marketplace, "OAuth once, every bot can use them" (README). OAuth is Composio's, brokered by their Cloudflare Worker (cloudflare/composio-broker). Cloud plans: 2,000 app events/day (/pro).
- Browser/computer use: Cua Driver on host; Boat cloud desktops with live preview + take-over (noVNC).
- Channels: primarily own desktop app + phone companion apps (iOS companion, phone web app, phone relay; docs/ios-companion.md, phone-web-app.md). "Phone apps (Discord)" link on site. Slack agents "Coming soon" (/pro). Telegram/WhatsApp only appear as third-party names / engine front doors (e.g. Hermes Agent Telegram) — not native channels [grep of docs].
- Voice: calls with own OpenAI key; TTS via ElevenLabs, Fish Audio, xAI, Mac voices, local Chatterbox (README).
- Skills/teams: `skills/` dir; installable team packages from one Markdown file (BotMRR, github.com/milind-soni/openmausbot-teams); share departments/presets.

## Monetization

- Free, open-source desktop app (Apache-2.0); "Provider fees and limits apply" (homepage).
- **MausBot Cloud** (mausbot.com/pro, seen 2026-11-13), USD monthly, BYO AI account:
  - Starter $15/mo: 100 computer-hours, ~30 min speech, 2 shared CPU/2 GB, up to 20 GB storage, 5 bots awake/2 working at once.
  - Pro $49/mo: 300 computer-hours, ~1 h speech, 4 CPU/4 GB, 100 GB, priority support + 30-min setup call.
  - Max $99/mo: 800 computer-hours, ~3 h speech, 8 CPU/8 GB, 100 GB.
  - All: up to 15 cloud computers at once, 2,000 app events/day, daily backups 14 days. Team plan up to 5 people; Enterprise page.
- Open-core: `enterprise/` needs license key for production; hosting for third parties needs partner agreement (LICENSING.md). GitHub Sponsors; sponsors Boat and ModelGo.

## Differentiator

- Multi-bot "team in a messaging app" with channels/rooms, auto-routing to the right bot, Chief of Staff bot — not a single assistant.
- Runs Claude Code, Codex, Grok CLI (and others) side by side per bot using existing subscriptions, local-first harness.
- Each bot gets its own computer (Boat cloud desktop, local VM, BYO-VPS Cua container, or host) with live view/take-over.
- Both MCP client and MCP server + headless CLI; portable Markdown team packages.
- Weaknesses: very fast-moving 0.1.x with known regressions noted in docs (e.g. #5225); always-on requires paid Cloud or self-hosted VPS; no native Telegram/WhatsApp/Slack channels yet; open-core enterprise carve-out; Windows installer unsigned; some secrets plaintext; dependence on Composio and Boat. Large codebase with tests/evals/CI (package.json scripts) — maturity signals good.

## Tech stack

- TypeScript (strict), Node >=24 (`--experimental-strip-types`), pnpm 10.33 workspace (package.json).
- Front-end: React 19, Vite, Tailwind CSS; desktop shell Electron ^43 (electron-builder.yml).
- Server: custom HTTP + SSE harness, `ws`, `zod`, `@modelcontextprotocol/ext-apps`; storage `node:sqlite` + NDJSON files.
- Hosted: Cloudflare Workers + D1 (control plane, Composio broker); Docker image (Caddy edge, Chrome/agent-browser), docker-compose, Fly.io, Podman.
- Sandbox: Boat cloud desktops, Cua containers/driver, local VM; AppArmor profile for Linux browser.
- Tests: vitest, node:test, evals/.

## Sources

- https://mausbot.com/ ; https://mausbot.com/pro (JSON-LD + pricing/FAQ)
- https://github.com/milind-soni/OpenMausBot (GitHub API metadata) — README.md, LICENSING.md, package.json, Dockerfile, deploy/install.sh, deploy/fly/, cloudflare/control-plane/wrangler.jsonc, cloudflare/composio-broker/, server/drivers/claude.ts, server/drivers/codex.ts, docs/byo-vps.md, docs/custom-mcp-servers.md, docs/mcp-server.md, docs/cli-onboarding.md
- https://github.com/milind-soni/openmausbot-releases/releases

## A. Agent browser

- Engine: **agent-browser** (pinned 0.37.0, run as an MCP stdio loop + daemon by the server; `server/browser-engine.ts`, `server/browser-runtime.ts:26,248`) driving Chrome over CDP. Chrome chosen once per machine (`server/browser/chrome/resolve.ts`, docs/browser-packaging.md): (1) the user's installed Google Chrome binary **with separate bot profiles** ("the person's Chrome profile is never touched"), else (2) pinned **Chrome for Testing** 153.0.8010.47 (SHA-256 checked), else (3) bundled **Chromium Headless Shell**. Docker/server image uses its Chrome for Testing via `AGENT_BROWSER_EXECUTABLE_PATH`. Built-in tools (`agent_browser_*`), not a user-added MCP.
- Where: on whichever host runs the OMB server — user's laptop (desktop), self-hosted VPS container, or the Fly "Cloud home". Separately, each bot may have a full Linux desktop (Boat cloud desktop, Cua container on BYO VPS via Docker-over-SSH, local VM) with live preview and noVNC take-over bound to random 127.0.0.1 port (docs/byo-vps.md). Built-in browser live view/takeover: `server/browser-live.ts`, `server/browser/viewers/` [details not read; INFERENCE that it streams CDP screencast].
- Profiles: per browser session/profile ("Settings → Browser profiles, or a bot's Browser panel"; shared profiles exist), cookies kept in the kept profile plus an autosaved restore file `<key>-<session>.json.enc`, **AES-256-GCM** keyed by SHA-256 of a server-held key file `browser-engine-key` (`server/browser-sites.ts:1-3,56-67`; `server/browser-engine.ts`). Per-site sign-out UI.
- Log in as user: "**My Chrome**" mode attaches to the user's own running Chrome (Chrome 144+, remote debugging enabled at chrome://inspect) for sites that block automation e.g. Google sign-in; off by default, desktop app or personal Cloud home lending a Mac/PC's Chrome over the device link; not on Team Cloud/self-hosted servers (docs/browser-packaging.md "Signed-in sites and My Chrome"). Bots can fill saved passwords; after a fill `agent_browser_eval` is refused on that page (`server/browser-secret-hold.ts`).
- Stealth: real Chrome UA without "HeadlessChrome", real client hints, `--disable-blink-features=AutomationControlled`, display size/lang/TZ matching, `--use-mock-keychain`/`--password-store=basic`; `scripts/verify-browser-identity.ts` checks public bot-test pages (docs/browser-packaging.md). No captcha-solving service found (grep "captcha" hits only `server/browser/cdp/health.ts`, `server/browser/prompt.ts`) [INFERENCE: detection/hand-off to human, not solving].
- Network: every bot Chrome goes through a per-session SOCKS5 **egress gate** on 127.0.0.1 that resolves DNS itself and blocks private/loopback/link-local/metadata addresses (anti-SSRF/DNS-rebinding), optional upstream SOCKS5 (`server/browser/egress/gate.ts`, `policy.ts`).

## B. Credentials and secrets

- Desktop: provider/service keys encrypted with Electron **safeStorage** (OS Keychain/DPAPI/libsecret; Linux without store → Electron fixed-key obfuscation) in `credentials.bin` (`electron/main.mjs:364`; docs/cli-onboarding.md:82). Plaintext exceptions: CLI-setup keys, OpenCode keys, per-engine `environment` keys, MCP header values in `config.json`, and `mcp-oauth.json` (same doc). UI is write-only ("configured" flags only; README).
- Claude/Codex subscription tokens: never handled by OMB as secrets; engines are the user's own `claude`/`codex` CLIs using their own login stores (e.g. `~/.claude`, `~/.codex`) [INFERENCE from driver design]. Claude driver strips parent `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, etc. per named account and deletes inherited `ANTHROPIC_API_KEY` so subscription login isn't flipped to API billing (`server/drivers/claude.ts:75-85,133-134`). Workspace keys (xAI, Mistral, OMB_* keys) are stripped from every spawned engine env (`server/credential-env.ts`). The agent CLI itself runs with the user's OS permissions on the host (default approval level "Full access"; docs/approval-levels.md), so it can in principle read local token files [INFERENCE].
- Gmail/OAuth apps: via **Composio**. Default path: OMB's Cloudflare Worker broker holds the shared Composio project key (Wrangler secret), issues each install a random bearer token stored only as SHA-256 in D1, gives it its own Composio user/session, **proxies MCP traffic** and returns Connect Links (`cloudflare/composio-broker/README.md`). So OAuth tokens live at Composio and traffic passes the vendor Worker. Self-host alternative: user's own Composio `ak_` project key, safeStorage-encrypted, no vendor broker contact (docs/composio.md). Agents use apps as tools; raw Gmail tokens are never in the sandbox [INFERENCE: Composio holds them].
- Cloud home: platform secrets (Boat, voice, AI trial, connected-apps grant…) passed to the server over an inherited pipe FD, never in child env, because `/proc/<pid>/environ` is readable (`server/cloud-secrets.ts`); connected-apps install token in `/data/.openmausbot/connected-apps-installation.json` mode 0600 (docs/composio.md). User's Claude/ChatGPT login happens on the Fly machine itself (docs/cloud-pro.md) → tokens stored on vendor-operated Fly volume [INFERENCE].
- Defences: approval levels (Ask / Auto-accept edits / Approve for me / Full access default / Codex config.toml) with Allow/Deny cards; per-bot "Sending on your behalf" setting gates sends through connected apps; per-bot connected-app scope (docs/approval-levels.md). Redaction (`shared/redact.ts` `scrubHeldSecrets`, `server/message-redaction.ts`), `agent-tool-policy.ts`, `gmail-draft-policy.ts`, `guarded-requests.ts`, egress gate, secret hold after password fill, team packages strip secrets. Audit: `admin-activity.ts`, `admin-audit-plan.ts` (enterprise/admin) [not read in detail]. Main weakness: default Full access, and no secret-injecting proxy for engine creds.

## C. Crons / scheduling

- "Routines": natural language ("at 9 am on the first of every month, in Asia/Kolkata") → bot creates cron via tools; or UI presets (one-time, daily/weekday, interval, monthly, yearly, custom 5-field cron). Computed with **Croner 10.0.1** in-process in the OMB Node server; "does not create a second timer service"; explicit IANA timezone required, DST handled (docs/routine-schedules.md; package.json). Agents create schedules via `trigger`/routine tools (`server/trigger-tools.ts`).
- State: `routines.json` in the data dir, mode 0600, with runs/receipts (`server/routines.ts:329`).
- Downtime: "OpenMausBot must be running to dispatch routines… a sleeping computer or a quit app runs nothing"; desktop keeps Mac awake an hour before a due routine while plugged in. Catch-up: up to **12 h late** one missed occurrence runs; older → "missed" receipt; no replay (`CATCH_UP_MS`, `server/routines.ts:281,958-1042`). No overlapping copies; interrupted runs resumed once on restart; one automatic retry; waits out Claude usage-limit resets ≤12 h; falls back to backup AI (`server/routine-recovery.ts`, docs).
- Checks: plain-code pre-checks (calendar, mail, other runs) on each tick before any AI turn, so quiet ticks cost nothing (docs/proactive-routines.md). Optional run time limit.
- Other triggers: webhooks (`server/webhook-ingress.ts`, 256 KB body cap, per-routine address); app events via Composio triggers → vendor broker queues events up to 7 days, OMB long-polls `GET /v1/events` (no public URL needed); Gmail polled every 15 min (docs/composio.md; homepage).
- Limits: Cloud Starter 5 bots awake/2 tasks at once (/pro). Laptop-off topology: self-hosted VPS (docs/deploy-vps.md) or MausBot Cloud Fly home (Starter homes may sleep when idle and wake for due routines via `server/cloud-power.ts`/`routine-due.ts`).

## D. Stack scope clarification

- Verified from repo for the **open-source/self-host build**: Electron+React desktop, Node server, agent-browser/Chrome, Croner, routines.json/SQLite, Docker image, `deploy/install.sh`, compose/Podman.
- **Hosted MausBot Cloud**: vendor documents it in-repo. Each customer = **one Fly.io app** with one always-on `home` machine, `/data` volume, `https://<app>.fly.dev`, own private 6PN network, running "this repository's `cloud-home` image (`Dockerfile`, `deploy/fly/`)" (docs/cloud-pro.md; deploy/fly/fly.toml). So the per-user runtime is the same open-source code/image (incl. `enterprise/` source-available layer). Closed/separate parts: "the Admin" (**openmaus-cloud**, separate repo not public, provisions apps via Fly Machines API, billing, signing secrets; docs/cloud-pro.md), Cloudflare Workers (control plane + Composio broker, source in repo `cloudflare/`, D1), Boat (boat.dev) for cloud desktops, Composio for app OAuth. Whether production images are built exactly from public `main` [UNVERIFIED]; no subprocessor list checked.

## E. Sandbox / agent computer: what it is used for

### 1. What it is

- **The agent loop itself** (claude/codex/grok CLI) runs where the MausBot server runs. On the desktop it runs on the host, working in the bot's folder (`workspaces/<bot>`) and an optional working folder. It is not sandboxed by OMB; only approval levels gate it (docs/approval-levels.md). On a **Cloud home** (Fly machine) every turn runs inside a per-process **bubblewrap** "bot box": read-only image (`/usr`, `/opt`: engine CLIs, node, python, git, the bots' browser), RW HOME with engine logins, RW turn folder + bot folder, private /tmp//proc/PID ns, **loopback-only network** with HTTP(S) egress via a proxy gate that blocks private/metadata/Fly 6PN addresses (docs/bot-box.md, `server/bot-box/`).
- **"Computer" = a tool target**, chosen per bot ("Works on": Auto / Cloud (Boat) / Local VM / This computer / browser only / Off; docs/analytics.md bot counters; `select_computer` tool). Options:
  - **Boat cloud desktop** (boat.dev sandbox): Linux desktop with live preview and "Open desktop" takeover in browser. Created in ~2 s, stop→archived ~5 s, resume ~8 s, **disk persists, tmux does not**, IP changes on resume (`server/boat.ts` header). Shell via `POST /sandboxes/{id}/commands`. Up to 15 at once on Cloud plans (/pro).
  - **Local VM** (Docker container on the host; modes `shared`/`per_bot`/`pool`) (docs/analytics.md, docs/bot-box.md).
  - **BYO VPS**: one hardened Cua Linux-desktop container per bot over Docker-over-SSH (docs/byo-vps.md).
  - **This computer**: GUI computer-use on the real Mac/Windows/Ubuntu-Xorg via the bundled **cua-driver** (accessibility, screenshots, clicks), opt-in (docs/computer-use-integration.md).
  - **Built-in browser** (agent-browser + Chrome, see §A), independent of the desktop.
  - Also an **Android phone** over ADB/USB (skills/phone-harness/SKILL.md).
- Capabilities: shell, file edit, run code, dev servers (ports listened to are tracked and previewable; docs mention "dev server… keeps counting"), GUI computer-use, browser automation, publish pages (`show_html`, `publish_page`), deploy to Netlify (skills/publish-to-netlify).

### 2. Use cases shown by the project

| Use case (source)                                                                                                                                                    | Needs computer?                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Sales Follow-up: "Finds the deals that went quiet… drafts each follow-up. Nothing sends until you approve it", weekdays 9:00, Gmail+HubSpot (mausbot.com job picker) | No; Composio apps                                                                      |
| Chief of Staff: reads inbox, calendar, team channels; one morning brief; reschedules meetings (homepage)                                                             | No                                                                                     |
| Recruiter (weekdays 8:00), Bookkeeper (Mondays 9:00), Support Triage (every 30 min), SEO Growth (Mondays 6:00), Competitor Watch, Bug Fixer (homepage presets)       | Bug Fixer/Competitor Watch likely yes (code, browsing) [INFERENCE]; others mostly apps |
| Overdue-invoice reminders: cloud desktop opens Mail, finds 4 overdue invoices, sends reminders (homepage "Every bot gets a computer" demo, `atlas@cloud`)            | Yes (cloud desktop GUI)                                                                |
| "3 PRs reviewed, 1 needs you" (homepage bot list)                                                                                                                    | Probably shell/git [INFERENCE]                                                         |
| Data dashboards / landing / pricing pages via `show_html`, shared with `publish_page` (skills/data-dashboards)                                                       | Light (HTML generation)                                                                |
| Deploy a site/app to a public link on Cloud-included hosting or the user's Netlify (skills/publish-to-netlify)                                                       | Yes (build/deploy)                                                                     |
| Social post previews for Instagram/LinkedIn/X etc. (skills/social-posts)                                                                                             | No                                                                                     |
| Control/test an Android phone over ADB: tap, type, screenshot (skills/phone-harness)                                                                                 | Yes (host + USB)                                                                       |
| Launch, drive and verify a specific app/project (skills/create-verification-skill)                                                                                   | Yes                                                                                    |
| "Rehearse the launch of https://example.com" headless run with `--export ./out` (README headless CLI)                                                                | Yes (browser)                                                                          |
| Google sign-in sites via user's own Chrome ("My Chrome") (docs/browser-packaging.md)                                                                                 | Browser                                                                                |

### 3. End-to-end flows

- **Scheduled, user absent (documented pieces; composed [INFERENCE])**: user tells Sales Follow-up bot "every weekday at 9" → bot creates cron routine (Croner, IANA tz; card shows next 3 dates, Edit/Pause/Undo; docs/routine-schedules.md) → on Cloud home the scheduler fires; plain-code checks run first → bot reads Gmail/HubSpot via Composio, drafts 4 follow-ups → sends need consent per "Sending on your behalf: Ask every time" (docs/approval-levels.md) → run waits ("Waiting for your approval…"), phone notification names the routine → user taps Send → "Sent all four" (homepage illustrative chat). Laptop may be off on Cloud; on desktop only within 12 h catch-up.
- **Cloud desktop with watch/takeover (homepage demo + README)**: user asks Atlas to chase overdue invoices → Computer panel spins up the bot's Boat desktop with live screen preview → bot opens Mail, finds invoices, sends reminders (steps shown as activity chips + screenshots folded into the transcript) → user can click "Open desktop" to take over in browser; risky shell/file actions appear as Allow/Deny cards (README features).
- **Files from a sleeping laptop (docs/files.md)**: user lends folder "Clients" (read-only or with editing) → My Cloud keeps a copy (≤3 GB) → while laptop is away a bot reads the copy and stages writes (≤256 KiB/file, ≤500 changes/64 MB, 30 days) → when laptop returns, changes land; on clash both versions are kept → bot outputs land in `Documents/MausBot/<bot>/<conversation>`.

### 4. File/data flow

- Desktop: bots work directly in host folders (working folder per bot/channel), so they can reach local files subject to approval level. Cloud: lent folders from the user's computer (`shared_computer` tool, live while on, copy while away) + bot outputs synced down to `Documents/MausBot/...` (docs/files.md). Publishing via `publish_page`/Netlify. Composio for app data. Boat desktop disk persists across stop/resume (`server/boat.ts`).
- Egress: Cloud bot box → only public internet through proxy gate, no LAN/metadata (docs/bot-box.md); browser → SOCKS gate with same policy (§A). Local VM unreachable from inside the bot box (Docker socket not exposed; docs).

### 5. Limits / caveats

- Cloud computer-hours 100/300/800 per month (Starter/Pro/Max); small computer counts as half an hour; max 15 concurrent; Starter home 2 CPU/2 GB, 5 bots awake, 2 tasks at once (/pro). A "static" tier mentions `boat-xlarge` (16 vCPU, 32 GB) [context not read; UNVERIFIED]. No GPU mentioned [UNVERIFIED].
- Desktop default is **Full access** with no OS sandbox for the engine: biggest isolation gap. Ubuntu Wayland host control disabled; Windows installer unsigned.
- Boat tmux/process state lost on stop; dedicated IP changes on resume. Apps/screen/terminal on the user's computer need it to be on (docs/files.md).

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

**F1. Verdict**

- **Hosted (MausBot Cloud): Yes, with caveats.** Each customer gets an always-on Fly "home" running the OMB server. You sign in to ChatGPT on that machine with Codex's device-code flow, and the in-process scheduler fires routines with the laptop off (docs/cloud-pro.md; /pro: "automations run around the clock, even with your laptop off"). I did not see an end-to-end doc example of a nightly Codex-subscription routine [UNVERIFIED as a tested flow], but no code restricts subscription engines in routines.
- **Self-hosted VPS: Yes.** It is the same server image (`deploy/install.sh`, docs/deploy-vps.md), with the same device-code login on the VPS.
- **Free desktop only: No.** "OpenMausBot must be running to dispatch routines… a sleeping computer or a quit app runs nothing" (docs/routine-schedules.md).

**F2. ChatGPT-subscription crux (hosted)**

- The Cloud engine sign-in offers ChatGPT as "the existing Codex device-code flow" (docs/cloud-pro.md §"engine sign-in", `src/components/CloudEngineSignIn.tsx`). The server runs `codex login --device-auth` **on the Cloud machine** (server/drivers/codex-device-auth.ts); you approve the code at OpenAI in any browser. There is no auth.json upload, no token pasting and no laptop relay, so the login survives the laptop being off.
- Storage: "Sign-ins stay on the machine's volume (`~/.claude`, `~/.codex`, `~/.grok`…)" (docs/cloud-pro.md), i.e. `<CODEX_HOME>/auth.json` (server/drivers/codex-login.ts) on the per-customer Fly volume `/data`, which the vendor operates (deploy/fly/fly.toml) [INFERENCE: vendor infra can physically access it].
- Refresh: the Codex CLI refreshes itself. For plan runs OMB feeds Codex a renewing token via `auth.command` from a run-local bridge (`refresh_interval_ms=30000`; server/drivers/codex-plan-token.ts).
- Expiry or revocation is detected (`CODEX_SIGN_IN_REFUSED`, server/drivers/codex-errors.ts:97). You get one notification "…signed out on the Cloud. Sign in again in Settings → AI", with no auto-retry. The run moves to a backup AI only if you configured one (docs/self-hosting.md "When an engine is signed out").
- The model call goes **from the Fly machine's IP** with your ChatGPT credentials. The project documents no ToS position on this; it only warns that "the person's AI plan limits apply to bots that work around the clock" and recommends Claude Max or API keys for heavy use (docs/cloud-pro.md). ToS/ban risk [UNVERIFIED, not documented].
- No vendor credits are forced: "Cloud includes no AI usage… Nothing on a Cloud home is routed to a platform model gateway". The only exception is a small one-time trial Claude credit (docs/cloud-pro.md). No plan restricts subscription use.
- Laptop and Cloud are two separate device logins to the same ChatGPT account. Possible conflict via refresh rotation is [UNVERIFIED]. OMB itself never uses "another sign-in to the same subscription" as a fallback (docs/self-hosting.md).

**F3. Setup UX (hosted)**

1. Install the desktop app (free) and buy Cloud Starter $15/mo via hosted checkout; an emailed link signs you in (/pro).
2. In the app, go to Settings → MausBot Cloud → sign in, then **Open My Cloud**. The welcome flow offers to move bots from this computer (docs/cloud-pro.md).
3. Engine sign-in: pick the **ChatGPT** tile, enter the device code at OpenAI, and see "Connected" (docs/cloud-pro.md).
4. Create a bot (New bot → name, Codex engine, model). The built-in browser is on by default (docs/browser-packaging.md).
5. Site login (human step): ask the bot to sign in with credentials you supply, or watch/take over the browser or desktop. 2FA or CAPTCHA requires you live. "My Chrome" does not apply at night because it needs your own computer on (docs/browser-packaging.md).
6. Schedule: say e.g. "every night at 03:00 Europe/Warsaw, scrape X and save a CSV". The bot converts this to cron, validated with Croner; the card shows the rule, the timezone and the next 3 dates, with Edit/Pause/Undo. Or use Automations → Schedule → Daily / Custom cron with an explicit IANA zone (docs/routine-schedules.md).
7. Test with **Run now** (docs/routine-schedules.md).
8. Approvals: the default is **Full access**, so shell, file and browser steps proceed unattended. Connected-app sends (e.g. Gmail) follow "Sending on your behalf" (Ask every time vs Send without asking). A run waiting for an approval blocks until you answer or the next occurrence supersedes it (docs/approval-levels.md; docs/routine-schedules.md).

**F4. Execution at 03:00**

- Trigger: Croner timers inside the Cloud home's OMB server; state lives in `routines.json` on `/data` (server/routines.ts:329). There is no external scheduler.
- Wake: on plans whose home sleeps, the Admin suspends it when idle and "wakes it again before the next scheduled run" (server/cloud-power.ts header; docs/cloud-pro.md "Sleeping homes": resume about 0.72 s, or about 20 s if stopped). Which plans sleep is not stated on /pro [UNVERIFIED]. Pro says "keep working 24/7".
- Run: Codex starts inside the bubblewrap bot box (node, python, git, browser in the image; docs/bot-box.md). The scrape uses the built-in agent-browser + Chrome (handles JS rendering and login cookies), with all traffic through the egress gate. The CSV is written by Codex shell/python into the turn's working folder [INFERENCE: no dedicated CSV/file-export tool].
- Persistence: the `/data` volume, with daily backups kept 14 days (/pro). Site cookies persist per browser profile in the kept profile plus an AES-GCM restore file (server/browser-sites.ts).
- Failure handling (docs/routine-schedules.md, server/routine-recovery.ts):
  - A stall, crash or rate limit gets one auto-retry.
  - A busy bot means the run waits up to 1 h.
  - A **usage limit** means the run continues on a backup AI if one is set; otherwise it waits for the reset (a known reset ≤12 h re-queues the run).
  - Sign-out or out of credit fails at once with one notification.
  - The log shows "N of M runs OK this week".
  - Site change or bot wall: no captcha solver, so it depends on the agent [INFERENCE: run fails or asks you].

**F5. Getting the CSV out**

- Chat reply in the bot's conversation, on desktop, phone companion or web (docs/cloud-pro.md).
- Automatic sync of bots' work to `Documents/MausBot/<bot>/<conversation>` on the laptop once it is on (default on; docs/files.md). Or write into a folder lent with editing; the change is staged and lands when the laptop returns.
- Email/Drive/Slack via Composio connected apps (Gmail, Google Drive, Slack included in Cloud; /pro). Needs send consent unless set to "Send without asking". Attachment support is [UNVERIFIED].
- Public link via `publish_page` (skills/data-dashboards). Git push via shell is possible [INFERENCE].

**F6. Gaps and risks**

- Cost: $15/mo Starter plus your ChatGPT plan's usage limits. The built-in browser runs on the home machine, so a nightly run should not consume Boat computer-hours unless the bot uses a Boat desktop (100 h/mo on Starter) [INFERENCE]. Per-run consumption is not documented.
- Signed-out ChatGPT with no backup AI means the nightly run fails, with only a notification.
- Starter has 2 shared CPU / 2 GB RAM and 2 tasks at once; Chrome + Codex may be tight [INFERENCE].
- Login sites: session expiry or 2FA needs you live; there is no captcha solving; datacenter (Fly) IP may be blocked by the site. The egress gate blocks private/intranet targets.
- ToS: subscription use from a vendor cloud IP is not addressed by the project [UNVERIFIED risk].
- The laptop gets the CSV only after it wakes and syncs; push delivery needs a connected app.
