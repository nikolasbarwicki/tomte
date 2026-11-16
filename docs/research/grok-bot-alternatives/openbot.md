# OpenBot (openbot.run) research (2026-11-13)

## What it is

- "A free desktop app that runs AI agents as a team on your own computer, with the ChatGPT, Claude, Gemini or Grok plan you already pay for" (openbot.run meta description). Electron desktop app (macOS/Windows/Linux) + iOS/Android companion apps that connect to your computer/server; persistent named agents, each backed by a provider CLI session (Codex, Claude Code, Grok CLI, Gemini/Antigravity, OpenCode, Cursor, Cline, Kimi, Devin, Copilot, Mistral Vibe, Hermes via ACP), with agent-to-agent messaging, handoffs, shared channels with human teammates ("multiplayer"), workflows/routines (README; homepage).
- Repo: https://github.com/nightly-labs/openbot — license **PolyForm Noncommercial 1.0.0** (LICENSE, package.json) — source-available, NOT OSI open source; commercial use needs a paid license. Requires CLA for contributions (CLA.md).
- Maintainer: Nightly Labs; package.json author Norbert Bodziony. 7,486 stars, created 2026-08-12, last push 2026-11-13 (gh api). Version 0.70.0; README: "A new release ships almost every day."

## Infra / self-hosting / laptop-off behavior

- Default: runs locally in the desktop app; agents run with `danger-full-access` and `approvalPolicy: never` (README warning) — no per-action confirmation after first-launch consent. Electron renderer sandbox kept on (AppArmor profile on Ubuntu; "Do not start OpenBot with --no-sandbox"). No per-agent container isolation on desktop [INFERENCE from README warning].
- Laptop off: desktop app alone stops when the computer is off. Three always-on options:
  1. **Self-hosted server** (free): headless Linux build on Ubuntu 24.04/26.04 with systemd: `curl -fsSL .../scripts/install-server.sh | sudo bash; sudo openbot login` (email code). Appears as a "Remote host" usable from desktop, iPhone app, or `openbot.run/app`. Can even be installed by an agent over SSH via tool `create_server_install_command` (docs/self-hosted-server.md).
  2. **Docker**: `linux/amd64`+`arm64` image built from the AppImage, Ubuntu 24.04 base, tini as PID 1, custom seccomp profile so Electron sandbox stays on (docker/Dockerfile, docker/seccomp.json, docs/docker.md). Also docs for AWS ECS (docs/aws-ecs.md).
  3. **Hosted server** (paid): each server is one **boat (boat.dev) sandbox** per account running the Linux build; stops after 15 min no use, data kept; a Cloudflare Worker cron wakes it before the next routine run, and the "Signal" service wakes it for Slack/Discord/Telegram messages addressed to OpenBot (docs/hosted-servers.md). Plan sizes map to boat `small`/`default`/`large`. Enterprise custom servers on Leaseweb VPS (.agents/skills/custom-server/SKILL.md).
- Scheduling: local `RoutineScheduler` (src/backend/agent/routine-scheduler.ts referenced in mailbox-sync.ts); routines/workflows with triggers like "Every Monday at 9:00" and approval steps (homepage). FIFO message queues with crash-safe persistence (README).
- Data: workspaces, conversations, attachments, browser data stay on the machine running OpenBot (homepage FAQ). Local DB is `node:sqlite` (60 imports in src/). Secrets encrypted with Electron `safeStorage` (docs/architecture/providers.md, events.md); provider CLIs keep their own credentials. Optional account API on Cloudflare Workers + D1 (README); Stripe billing (hosted-servers.md).

## Claude / Codex subscription use

- Yes, both, via the official CLIs. Claude: Claude Agent SDK spawning the unmodified `claude` binary (downloaded from `@anthropic-ai/claude-agent-sdk-<platform>` with integrity check); Connect runs `claude auth login --claudeai`; OpenBot says it does not read/copy/store credentials; on headless Linux, a pasted-code relay (docs/provider-terms.md, docs/architecture/integrations.md).
- Codex: local Codex App Server; sign-in via ChatGPT browser login or device code (`codex-device`) (README; integrations.md). Gemini via Antigravity CLI with Google AI Pro/Ultra sign-in; Grok, Cline, Kimi, Muse via device code; Cursor via pasted code (integrations.md; FAQ).
- Other: any ACP agent (Goose, Qwen Code), OpenAI-compatible endpoints, Ollama/LM Studio, Inception Mercury, Pi, OpenCode free models; `ANTHROPIC_API_KEY`/Bedrock/Vertex/Foundry for Claude (provider-terms.md; FAQ). Automatic fallback to a backup model/provider when a plan hits its limit, keeping chat + workspace (homepage).
- ToS: unusually explicit `docs/provider-terms.md` quotes Anthropic's terms (read 2026-10-06) and rates risk: own work on own computer "Not clear"; remote-host code sign-in "Higher"; team members using your Claude plan "High". States Anthropic has not confirmed it is permitted, and recommends API key.

## MCPs / apps / integrations

- MCP client: user-added URL MCP servers with full OAuth (`McpOAuth`, loopback callback port 28417 `/mcp-auth`, token refresh/RFC 7009 revocation; src/backend/mcp-oauth-provider.ts). OpenBot also exposes its own tools to agents through an MCP gateway (`src/backend/agent/mcp-gateway.ts`, `createSdkMcpServer`).
- Marketplace of plugins (MCP server + optional skills; `marketplace/`, docs/plugin-distribution.md); ~40 catalog listings incl. Notion, Linear, Atlassian, Airtable, Figma, Stripe, Sentry, Vercel, GitLab, Composio, Firecrawl, Todoist, Trello (apps/auth-api/src/content/plugins/). Skills per agent (docs/architecture/skills-and-plugins.md).
- Gmail/Drive: via Google's MCP servers with OAuth sign-in through McpOAuth (comment in mcp-oauth-provider.ts:1826 about "Google's MCP servers, such as Gmail or Drive"), or via Composio plugin [INFERENCE: no dedicated Gmail OAuth app found]. GitHub connector via device code. Password managers: 1Password, Bitwarden, Proton Pass (integrations.md).
- Built-in persistent embedded browser agents control; optional Computer Use via `cua-driver` binary (README).
- Chat channels: Slack (one OpenBot Slack app; "Slack Orchestrator" agent routes to agents; events via OpenBot Signal service), Discord, Telegram, WhatsApp (docs/messaging.md; apps/*-app, packages/whatsapp); plus desktop, mobile apps, web `openbot.run/app`. Inbound webhooks (Standard Webhooks; Composio/Svix triggers; docs/webhooks.md); local scripts API + `openbot-cli` (docs/automation.md).

## Monetization (openbot.run/pricing, seen 2026-11-13)

- Personal/noncommercial: €0, every feature.
- Hosted server (yearly prices, −20%): Starter €16/mo (12 GB, "Sold out"), Standard €40/mo (50 GB, 2× speed, up to 5 members), Pro €80/mo (100 GB, 4× speed); monthly €20/€50/€100.
- Work license: Starter license €7.20/mo (1 member; €10 monthly), Team license €18/mo with 2 included +€10.80 each more (€25 monthly); "Free until December 1, 2026"; −10% bundled with a server. Enterprise: contact sales. Currencies EUR/USD/PLN/BRL. "OpenBot for Teams": managed servers + custom integrations + implementation (homepage).
- Model usage not resold: "OpenBot does not sell, resell or pay for model usage" (provider-terms.md).

## Differentiator

- Orchestrator over _many_ vendor coding-agent CLIs (12+ incl. ACP), with per-agent provider switching and automatic fallback when a subscription limit is hit — the most "use every subscription you already have" product.
- Multi-agent team metaphor: named agents message, hand off, review; humans join shared channels (multiplayer).
- Same binary runs desktop, headless VPS, Docker, or vendor-hosted boat sandbox that sleeps and is woken by cron/chat events — clear laptop-off story with free self-host.
- Very thorough engineering docs incl. candid ToS risk table.
- Weaknesses: source-available noncommercial license (not open source), CLA; agents run full-access with no approvals by default; very young (repo created 2026-08) with near-daily releases (churn); messaging connectors (Slack etc.) route through vendor Signal service and require an OpenBot account; Claude subscription use explicitly unclear under Anthropic ToS.

## Tech stack

- TypeScript, Bun (bun.lock, bunfig.toml) monorepo; Electron 45.3.0 + electron-vite; SolidJS 2.0 rc front-end, Tailwind 4, Kobalte; Effect (effect-ts) in backend (package.json; mailbox-sync.ts).
- Storage: `node:sqlite` locally; Cloudflare Workers + D1 for account API (`apps/auth-api`, wrangler.jsonc); Stripe; boat.dev sandboxes and Leaseweb VPS for hosting; `remote/` with nginx, coturn, ACME compose stack (remote desktop/WebRTC [INFERENCE]).
- Mobile app (apps/mobile), Nix flake, Docker (Ubuntu 24.04 + seccomp), electron-builder packaging, Vitest, Biome, knip, GitHub Actions CI.

## Sources

- https://openbot.run/ ; https://openbot.run/pricing
- https://github.com/nightly-labs/openbot (README.md, LICENSE, CLA.md, package.json, docker/Dockerfile)
- docs/self-hosted-server.md, docs/hosted-servers.md, docs/docker.md, docs/provider-terms.md, docs/automation.md, docs/messaging.md, docs/webhooks.md, docs/architecture/integrations.md, docs/architecture/providers.md
- src/backend/mcp-oauth-provider.ts, src/backend/agent/mailbox-sync.ts, apps/auth-api/src/content/plugins/, .agents/skills/custom-server/SKILL.md
- gh api repos/nightly-labs/openbot (stars, dates)

## A. Agent browser

- Tech: the **Electron-embedded Chromium** of the app itself. Tabs are Electron `WebContentsView`s, and agent actions go through **CDP** (`browser-tool-actions.ts` maps tools to CDP operations; `BrowserHost` owns tabs/queues). It is a built-in tool, not an MCP server, and does not use Playwright, Browserbase or the user's Chrome (docs/architecture/browser.md "Browser tool execution").
- Where/display: on the machine that runs OpenBot. On the desktop it is a **headed panel the user watches**. On hosted/self-hosted Linux servers it runs on **Xvfb** (1280x800 via `xvfb-run`, two virtual displays when there is no desktop session), with gnome-keyring under Xvfb (docs/hosted-servers.md ~L305, 616-624). Remote users see a live view streamed over WebRTC (`BrowserLiveView`, `packages/team-client` browser-view streams; browser.md). Sign-ins on servers finish on the user's own device because "the sandbox browser is on Xvfb, where nobody can see it" (hosted-servers.md L305).
- Watch/take over: yes. The tools `request_takeover` and "Take control" pause the agent; secure input cards handle passwords, codes, CAPTCHA and passkeys (browser.md L149-152, 189).
- Profiles: persistent Electron partitions. The default is a **shared** `persist:openbot-browser`; there is also an "Only this agent" partition `persist:openbot-browser-agent-<sha256(agentId)[:32]>`, and named profiles shared by several agents (`browser_profiles` table, migration 45). `openPrivate` gives an in-memory partition (browser.md "Browser sessions").
- Login as user: it is a **separate profile**. The user signs in inside the agent's panel ("so the user can sign in for the agent there"). I found no import of the user's Chrome profile or cookies [UNVERIFIED negative]. Logins can be filled from 1Password, Bitwarden or Proton Pass (skills-and-plugins.md).
- Anti-bot measures:
  - Strips the `Electron/` and `OpenBot/` tokens from the user agent, normalises it to `Chrome/<major>.0.0.0`, adds `Accept-Language`, and synthesises Client Hints consistent with `navigator.userAgentData` "Cloudflare rejects…" (browser.md L118-135).
  - Auto-rejects cookie banners (`browser-consent.ts`).
  - Detects bot walls (Cloudflare, DataDome, PerimeterX, Imperva, Akamai, AWS WAF) in `browser-challenge.ts` and waits up to 15 s.
  - Clicks the Turnstile, reCAPTCHA or hCaptcha checkbox once (it finds the Turnstile frame via CDP `DOM.getFrameOwner`). Otherwise it hands over to a human, and agents are told "not to solve, reload, or retry" (browser.md L177-200).
- Also has Computer Use through the `cua-driver` binary (README).

## B. Credentials and secrets

- **Provider subscriptions:** stored by each vendor CLI in its own location (e.g. `claude` CLI and Codex auth files). "OpenBot does not read, copy or store them" (docs/provider-terms.md). Agents run as the same OS user, so the provider token files are reachable by agent shell commands [INFERENCE from full-access default plus same-user note below].
- **Agent API keys (`request_api_key`):**
  - Without the Vault, they are written to `<userData>/agent-api-keys/<agentId>/<NAME>` as a 0600 file in a 0700 folder, "**not encrypted**".
  - With the Vault, the key is materialised to `.vault/<agentId>/<NAME>` for each allowed agent.
  - The agent gets only the name and path and reads the file with its own command, so **the raw secret reaches the agent's sandbox**, not just a broker.
  - Docs admit: "All agents run as the same system user, so an agent can read the key files of other agents: the scope controls which agents OpenBot gives a key to, not which agents can read it" (docs/architecture/skills-and-plugins.md L133-148; `src/backend/agent-api-keys.ts`; changelog.d/t3-isolate-agent-secrets.md).
  - Values are registered for log redaction. The form is refused in Slack, Discord and Telegram chats.
- **Encrypted with Electron `safeStorage`** (macOS Keychain, Windows DPAPI, libsecret/gnome-keyring on Linux; hosted servers set a random keyring password per server, hosted-servers.md L615):
  - messaging bot tokens (`MessagingCredentialStore`, channels-and-messaging.md L686);
  - webhook secrets (events.md L46);
  - optional provider keys in a "0o600 envelope under userData" (providers.md L683);
  - the 1Password connector (skills-and-plugins.md L89);
  - the routine feed token.
- **MCP OAuth tokens** (Gmail, Drive and others) are held on the host by `McpOAuth` and handed to agents as an access token (`accessToken`) (integrations.md). The host "keeps every grant"; on a joined server, that is the host.
- **Vendor cloud:**
  - The Telegram bot token is held by OpenBot's **Signal** service: "Signal holds the bot token; this computer never has it" (docs/messaging.md L129). Slack and Discord events also route via Signal.
  - The account Worker (Cloudflare) stores no conversations or files, and "its boat key cannot read them" (PRIVACY.md hosted servers).
  - Remote sign-ins are relayed through a callback relay (integrations.md).
  - Composio is only an optional marketplace plugin.
- **Defences:**
  - The default is **Full access** with `approvalPolicy: never` (README). Per-agent "Ask first" vs "Full access" plus workspace-only access; only the user can widen, and agents can only restrict (agents.md L911-917).
  - Workspace-only mode uses process confinement and "fails closed on hosts without confinement support" (providers.md L1636). I did not identify the confinement tech [UNVERIFIED].
  - Approval cards (`awaitToolApproval`) for MCP server changes and workflow deletion. Secure-input tabs are isolated from cross-site frames.
  - Docs admit "Prompt injection can still use an approved account on its own site" (skills-and-plugins.md L129). No dedicated audit log was found beyond the run history and event log [UNVERIFIED].

## C. Crons / scheduling

- **Component:** in-process `RoutineScheduler` (src/backend/agent/routine-scheduler.ts). **One `setTimeout`** shared by all routine owners (`src/backend/routine-timer.ts`) is armed for the earliest `nextDueAt` read from SQLite (`AgentRoutineStore`). Run rows commit before the trigger advances, for crash recovery (agents.md "Scheduled routine changes").
- **Schedule kinds:** `once`, `interval` (minimum **3 minutes**, `ROUTINE_MINIMUM_INTERVAL_MINUTES` in packages/contracts/src/ipc-routines.ts), daily/weekly, and "advanced"/custom **cron** (`scheduleCronSpec` in packages/team-client/src/routine-schedule.ts). Agents create schedules as structured tool arguments (`routine-tools.ts`), not by parsing natural language.
- **Timezone:**
  - A routine stores its own zone.
  - When the agent creates a routine, it uses the sender's client zone for that delivery, else the server zone, else the host's zone (routine-scheduler.ts L124-200).
- **Missed runs:** `missedPolicy` is `skip` or `run-once` ("runs the newest one when OpenBot opens and records the others"). `collapseMissedOccurrences` prevents bursts. A missed one-time routine is always queued. There is no overlap: an occurrence is dropped if a run is still live (ipc-routines.ts; routine-scheduler.ts L905-935).
- **Cost controls:**
  - `limitPolicy` is `wait` (until the plan resets) or `skip` while the provider plan is spent.
  - `automationRunsPerHour` limits runs from scripts.
  - Quiet runs (`[[no-update]]` / `[SILENT]`) suppress notifications.
  - Workflow tokens are counted under `WORKFLOWS_USAGE_ID` (agents.md).
- **Other triggers:**
  - Webhook routines (Standard Webhooks; Composio and Svix triggers).
  - GitHub App events for workflows (`github-matching.ts`).
  - A local scripts API and `openbot-cli`.
  - Slack, Discord, Telegram and WhatsApp messages.
  - Agent-to-agent handoffs and routine flows; workflows with approval steps.
  - I found no email or polling trigger [UNVERIFIED].
- **Run history:** run rows, last run on the Routines canvas, and an iCalendar feed of the next 30 days on loopback (agents.md "Routine calendar feed").
- **Laptop off:** only a host that is on fires schedules: a self-hosted VPS or Docker container (systemd, always on), or a hosted server. Hosted servers sleep, so the server reports its next routine time to the Worker (`hosted-server-activity.ts`). The **Cloudflare Worker cron** (`* * * * *` in `apps/auth-api/wrangler.jsonc`) wakes the sandbox "a few minutes before its next scheduled routine run" (PRIVACY.md; hosted-servers.md).

## D. Stack scope clarification

- **Verified for the open-source/self-host build:** the Electron, Bun, SolidJS, Effect and `node:sqlite` desktop app; the headless Linux server (install-server.sh, systemd); the Docker image (docker/Dockerfile built from the release AppImage). All of these are in the public repo.
- **Hosted cloud:**
  - It runs the **same Linux release build** downloaded from GitHub Releases ("A hosted server updates itself: it downloads the newest release from GitHub Releases", PRIVACY.md).
  - It runs on a **Leaseweb VPS** from an operator-managed pool when one is free, otherwise in a **boat.dev sandbox in the EU (Germany, Finland or France)** (PRIVACY.md "Hosted servers"; docs/hosted-servers.md; `scripts/hosting/leaseweb-pool.ts`).
  - The control plane is also in the public repo:
    - the account/billing Worker (`apps/auth-api`): Cloudflare Workers + D1 + R2, Stripe;
    - the Signal relay;
    - the Slack, Discord and Telegram apps (`apps/*-app`);
    - the `remote/` stack (nginx, coturn TURN, ACME, compose).
  - Production secrets live in an encrypted `apps/auth-api/.env.dev` and dotenvx keys (hosted-servers.md L368-397).
- **Conclusion:** the hosted product appears to be the open-source code plus vendor-operated infra. I found no evidence of a private fork; whether undisclosed private services exist is [UNVERIFIED]. Subprocessors named in PRIVACY.md: Cloudflare, boat, Leaseweb, Stripe and OpenPanel (analytics). Mail for email codes is likely Resend [INFERENCE from plugin/webhook mentions; unverified].

## E. Sandbox / agent computer: what it is used for

**1. What the "computer" is**

- **No per-agent container or VM.** The agent's computer is **the machine that runs OpenBot**: your desktop, your own VPS or Docker container, or a hosted Linux server (Leaseweb VPS or boat.dev sandbox). Agents run as the **same OS user** as OpenBot (skills-and-plugins.md L140), with `danger-full-access` by default (README). Optional "workspace-only" process confinement fails closed (providers.md L1636).
- **Granularity:**
  - Each agent has a persistent workspace folder `~/OpenBot/Agents/<id>` (docs/glossary.md L8), plus a shared `~/OpenBot/Shared` folder and a shared SQLite DB at `~/OpenBot/Shared/Data/agent-data.db` (glossary.md L78).
  - Each thread runs its own provider CLI process: "one `claude` process for each thread" (hosted-servers.md "Memory").
  - A hosted server is per account/team, not per agent.
- **Lifecycle:**
  - Desktop: runs while the app is open.
  - Self-host or Docker: always on (systemd/tini).
  - Hosted: sleeps 15–30 minutes after last use, with a boat disk snapshot kept, and wakes on a client action, a chat message or the next routine (PRIVACY.md "Hosted servers").
  - The disk and home directory persist.
- **Installed on servers:** the Ubuntu package list `resources/hosting/packages.txt` (Xvfb, D-Bus, gnome-keyring, Electron libraries, remote-desktop runtime, CJK fonts, "the tools that they use most"; docker/Dockerfile comments). Provider CLIs are downloaded by OpenBot. I didn't list the exact tools (python/node/ffmpeg) [UNVERIFIED].
- **What the agent can do there:**
  - Full shell, file editing, package installs and git, through the provider CLI's own tools (Codex, Claude Code and others).
  - The embedded Chromium browser.
  - GUI **Computer Use** via the `cua-driver` daemon (screen capture, accessibility reads, input) on macOS, Windows and Linux. On servers this runs on a dedicated Xvfb agent display (`OPENBOT_AGENT_DISPLAY`) that humans can watch through remote desktop (docs/architecture/computer-use.md).
  - OpenBot tools (src/backend/openbot-tools.ts): `publish_site`/`replace_site` (static hosting, 30-day expiry), `html_preview`/`html_render` (visual HTML replies), `capture_screen`, `read_video`, `web_search`, `attach_files_to_response`, `send_to_channel`, `create_agent`, `create_routine`, `test_routine`, `ask_ui`, `request_api_key`, `remember`, `create_server_install_command`.
  - It is the **main execution place of the agent loop**: the provider CLI runs locally on that host, not just as a tool target.

**2. Use cases shown by the project** (the guide `apps/auth-api/src/content/guides/ai-agents-examples.tsx`, "20 examples… tasks to try"; homepage; docs)

1. Compare vendors: read three official pricing pages and save a table. Uses the browser plus files in the workspace (sandbox).
2. Track documentation changes against a saved copy (workspace files plus browser).
3. Investigate a bug: reproduce it in a repo and save findings before changing code. Needs a shell/sandbox.
4. Review a PR with a second agent that reports file locations and failure scenarios (repo access; agent-to-agent handoff).
5. Plan a dependency update from the official migration guide, listing affected code and tests (shell).
6. Summarize a campaign CSV export with the calculations, or check a data file for missing values and duplicates (files; code execution [INFERENCE]).
7. Find duplicate contacts in a CRM export, not the live CRM (files only).
8. Draft a support answer or a weekly project update from exports. Needs files only, no sandbox code.
9. Homepage example: fix a Safari sign-in test failure in `session.ts`, hand off for review, merge (coding in the workspace).
10. Homepage workflow: "Every Monday at 9:00" Ada summarizes last week's issues → Grace collects usage numbers → Linus writes the weekly report → Alan makes charts → approval step "Post the report?" (routine plus approval).
11. Publish a static site from the workspace with `publish_site` (openbot-tools.ts L281).
12. Install OpenBot on a VPS over SSH from a chat ("Install OpenBot on root@203.0.113.7…"; docs/self-hosted-server.md).
13. Computer Use on desktop apps, including from scheduled tasks (computer-use.md).

- **No sandbox needed:** MCP or connector calls (Notion, Linear and others), Slack, Discord or Telegram replies, drafting text.

**3. End-to-end flows**

- **Flow A: absent user, scheduled.** Source: homepage workflow, docs/architecture/agents.md "Routine flows", hosted-servers.md.
  1. The user builds a workflow: weekly trigger → agents → approval → output.
  2. With the laptop off, the hosted server is asleep. The Worker cron wakes it a few minutes before the run.
  3. `RoutineScheduler` enqueues the run, and each agent works in its workspace. Steps hand off through `RoutineScheduler.enqueueHandoff`.
  4. The approval step waits for the user ("a rejection stops the run").
  5. The output shows a notification or posts to a messaging place, e.g. Slack.
  6. If a step needs a person (a captcha or a question), the run is marked `needs-attention`, or a report is sent in routine runs (browser.md L189).
- **Flow B: human takeover in the browser.** Source: browser.md L139-200 and skills-and-plugins.md.
  1. The user asks an agent to do something on a site that needs a login.
  2. The agent opens a tab in its profile partition.
  3. A challenge-detection snapshot reports `needs-user`, or a password field appears. The agent calls `request_takeover`, or the secure input card fills credentials from 1Password, Bitwarden or Proton Pass.
  4. The user takes control in the panel (desktop) or the WebRTC live view (mobile or web), signs in or solves the CAPTCHA, then gives control back.
  5. The cookies persist in the agent's partition, so later scheduled runs reuse the session [INFERENCE from persistent partitions].
- **Flow C: coding with a reviewer.** Source: homepage "#launch" demo [INFERENCE: marketing illustration].
  1. A message in a channel assigns a failing test to Linus.
  2. Linus's Codex or Claude CLI edits `session.ts` in its workspace and hands off to Grace for review.
  3. Grace reviews and merges, and the user closes the issue.
  4. If Codex hits its plan limit, the agent can switch to Claude Code while keeping its workspace (homepage).

**4. File and data flow**

- **In:**
  - Chat attachments (images, PDFs, ZIP, MP3/MOV and more; browser.md L79-100).
  - Managed file transfers between agents and from clients over WebRTC (`packages/team-client`).
  - The shared `~/OpenBot/Shared` folder.
  - Git clone via the shell.
  - Imports of agent ZIPs (`openbot-import.json`).
- **Out:**
  - `attach_files_to_response`.
  - `html_render` pages.
  - `publish_site`: files go to Cloudflare R2, at 3/10/50 sites on Starter/Standard/Pro (docs/architecture/servers.md L111-120).
  - Git push and messaging posts.
- **Local file access:**
  - On the desktop the agent **can reach all of the user's files**, because it is the user's OS user with full access. Only workspace-only mode restricts it.
  - On a hosted or self-hosted server it reaches only the server's disk; the user's laptop isn't mounted.
- **Network:** no egress limits found [UNVERIFIED negative]. The README says agents "use the network" freely.

**5. Limits and caveats**

- **Isolation:**
  - No per-agent container. All agents share one OS user and can read each other's key files.
  - Full access with no approvals by default.
  - The docs accept that prompt injection can misuse approved accounts.
- **Resources:**
  - A Starter hosted server has 4 GB RAM (plus zram/swap). One systemd unit holds everything with `MemoryMax=90%`, and provider CLIs and MCP servers are OOM-killed first (hosted-servers.md "Memory").
  - Storage is 12/50/100 GB on Starter/Standard/Pro, which advertise 1×/2×/4× "speed" (pricing).
  - No GPU is mentioned [UNVERIFIED].
- **Availability:**
  - A hosted server sleeps after 15–30 minutes and wakes with a delay.
  - Gemini sign-in can't complete on a server with no desktop (README).
  - Remote desktop works only on X11 and x64 Linux.
- **Cost:** a flat monthly server fee (€16–80 per month yearly), not per hour. Model usage goes on the user's own plans.

## F. Scenario: nightly scrape to CSV on ChatGPT subscription, laptop off

**1. Verdict: yes, but only on an always-on OpenBot server.** That means a self-hosted VPS or Docker host (free for personal use), or a paid hosted server. The desktop app alone can't do it, because the scheduler is in-process and fires only while OpenBot runs (`src/backend/routine-timer.ts`). A missed run is only skipped or run once at the next start (`ROUTINE_MISSED_POLICIES`, packages/contracts/src/ipc-routines.ts).

- What's documented: device-code Codex sign-in on servers (docs/hosted-servers.md "Providers"), routines on the server, and the Worker waking a server before a routine. All the pieces are documented.
- What's missing: I found no doc or test that explicitly shows a _scheduled_ run on a Codex/ChatGPT login [UNVERIFIED end-to-end]. I also found no code that refuses subscription providers in routines [UNVERIFIED negative; grep of agents.md and providers.md].

**2. How ChatGPT auth reaches the host**

- **Which process calls the model:** the **Codex CLI app server** (`codex app-server`) on the always-on host. One app server per account holds every thread (providers.md L328; `src/backend/app-server-client.ts`). OpenBot's vendor cloud never calls the model ("OpenBot does not sell, resell or pay for model usage", provider-terms.md).
- **How the login gets there:**
  - The provider driver `codex` has `signIn: browser` and `codeSignIn: codex-device`, and account sign-in runs `codex login` with `CODEX_HOME` per account (`src/backend/provider-drivers.ts` ~L951-958).
  - On a server, "Codex, Grok and Cline show a device code": the host starts the device flow and the user's phone or laptop shows the code (hosted-servers.md L303-311; integrations.md "Device code").
  - No `auth.json` upload or laptop copy is needed.
- **Token storage:** the Codex CLI's own `auth.json` under `CODEX_HOME` on the host (`~/.codex` for the first account; extra accounts get their own folder). OpenBot doesn't store it (provider-terms.md "OpenBot does not read, copy or store").
- **Refresh:** done by the Codex CLI itself [INFERENCE: standard Codex CLI behaviour; OpenBot docs don't describe Codex refresh]. If the sign-in breaks, accounts "wait for a Reconnect" (providers.md L1525), so a run at 3 am fails until a human reconnects.
- **Usage limit at 3 am:**
  - The plan limit puts a hold on every agent using that provider account and model until the reset.
  - With backup models set (up to 8, `AgentBackupModels`), `UsageLimitGate` moves the agent to the next ready model, e.g. Claude or a local model (providers.md L1411-1430).
  - The routine's `limitPolicy` is `wait` (stays queued until the reset) or `skip` (dropped) (ipc-routines.ts).
- **Laptop conflict:** the server login is a separate device-code session from the laptop's `~/.codex`. I found nothing on single-session or refresh-rotation conflicts [UNVERIFIED].
- **ToS:** provider-terms.md has a Claude risk table only. For others it says "read what the provider says about third-party tools" (no OpenAI-specific analysis).

**3. Setup for the cheapest path: self-hosted VPS** [INFERENCE: composed from documented steps]

1. Rent an Ubuntu 24.04 VPS. On it, run `curl -fsSL …/scripts/install-server.sh | sudo bash`, then `sudo openbot login` with an email code. Or use the claim command from desktop Add server (docs/self-hosted-server.md).
2. In the desktop, phone or `openbot.run/app` client, open the server. The provider step shows a Codex device code; enter it on OpenAI's page with your ChatGPT account (hosted-servers.md "Providers").
3. Create an agent from a prompt (homepage "describe the agent you want in one prompt"). Optionally set backup models.
4. Create the routine:
   - either ask the agent in chat ("every night at 3:00 scrape X and save a CSV"); the agent calls `create_routine` with a structured schedule (once/interval ≥3 min/daily/weekly/cron) (`routine-tools.ts`);
   - or use the routine settings / Routines canvas.
   - Timezone: the sender's client zone for that message, else the server zone (routine-scheduler.ts L124-200).
   - Choose `missedPolicy` and `limitPolicy`, and `runIn` chat or thread.
   - Test with `test_routine` or "Run now" (agents.md; openbot-tools.ts).
5. **Site login:** open the agent's browser panel through the live view and sign in once. Cookies persist in the agent's partition (`persist:openbot-browser-agent-…`), or the default shared partition (browser.md "Browser sessions"). Alternatively, 1Password, Bitwarden or Proton Pass fill credentials via secure input.
6. **Approvals:** the default agent access is Full access with `approvalPolicy: never` (README), so nothing blocks at 3 am unless the workflow has an explicit approval step or the agent asks a question. In that case the run goes to `needs-attention` and waits (agents.md "Routine flows"; routine-scheduler.ts doc comment).

**4. At night**

- **What fires it:**
  - Self-host: the in-process single `setTimeout` armed for the earliest `nextDueAt` from SQLite (routine-timer.ts; routine-scheduler.ts).
  - Hosted: the server reports its next routine time, and the Worker cron (`* * * * *`, apps/auth-api/wrangler.jsonc) wakes the boat sandbox "a few minutes before" (PRIVACY.md).
- **What starts:** a new provider session per run ("A routine run… does not resume a provider session", agents.md ~L166). The Codex thread runs in the agent workspace `~/OpenBot/Agents/<id>`, uses the embedded Chromium (on Xvfb) through CDP tools, and writes the CSV with the shell or code (Codex's own tools) [INFERENCE: no CSV-specific tool exists].
- **Failure handling:**
  - Bot wall or CAPTCHA: the challenge detector waits 15 s; if it is still there, `needs-user`. "In a routine run, a report" rather than a takeover (browser.md L189).
  - Expired login: the agent sees a login page, so it reports or asks a question [INFERENCE].
  - Provider error before any work: fails over to a backup model. After the turn has acted, the run fails with the error shown in run history (providers.md L1430-1436; agents.md L103-107).
  - No automatic retry for a failed run was found [UNVERIFIED].
  - An overlapping occurrence is skipped if the previous run is still live.

**5. Morning UX**

- The run appears in the agent chat or routine side thread, with run status and errors in run history and the last run on the Routines canvas (agents.md).
- The agent can attach the CSV (`attach_files_to_response`) to its reply, or post it through `send_to_channel` or a workflow output to Slack, Discord or Telegram. Whether chat attachments carry files to Telegram/Slack: [UNVERIFIED].
- The user downloads it via file transfer in the desktop, phone or web client. Re-run with "Run now" or `test_routine`.
- Notifications: desktop and phone push on completion, unless quiet runs (`[[no-update]]`) are used (agents.md L69-151).

**6. Cost**

- **Self-host:** OpenBot is €0 for personal use; commercial use needs a license (€7.20/mo yearly, free until 2026-12-01). The VPS is the user's own cost; a 4 GB machine is sensible, given the 4 GB Starter sizing.
- **Hosted:** Starter €16/mo yearly (€20 monthly) is "Sold out", so in practice Standard is €40/mo yearly (openbot.run/pricing, 2026-11-13). Pricing is a flat monthly fee, not per compute hour, and the sandbox sleeps between uses.
- **Model:** the ChatGPT usage counts against the user's own plan limits; there is no OpenBot model charge.

**7. Gotchas**

- **Laptop-only install silently doesn't run.** The desktop app with the laptop off fires nothing; on the next start, `skip` drops the missed runs and `run-once` runs only the newest.
- **Lost Codex login waits for a manual Reconnect.**
- **Usage limit with `limitPolicy: skip` drops the run.** With `wait`, the run is delayed until the plan resets.
- **CAPTCHAs aren't solved.** At night a bot wall produces a report, not data.
- **Site sessions expire.** Persistent cookies in the agent's profile are the only login mechanism unless a password manager is connected.
- **Shared profile by default.** Other agents share the default browser partition unless "Only this agent" is chosen.
- **Hosted server wake-up is timed.** It wakes only a few minutes before the run; a failed wake means a missed run [INFERENCE].
- **Full access with no approvals.** The nightly agent can do anything on the host, and prompt injection from the scraped site is a documented, unmitigated risk (skills-and-plugins.md L129).

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off (hosted plan first)

This supersedes the ordering of the self-host-first section F above. The evidence is the same; the cited file paths are in that section.

**F1. Verdicts**

- **Hosted plan: Yes, with caveats** [docs-backed; not shown end-to-end].
  - A hosted server is a Linux OpenBot running in a boat.dev sandbox or a Leaseweb VPS. It holds its own Codex CLI login made by device code, and the Worker cron wakes it before routine runs. So nothing depends on the laptop (docs/hosted-servers.md "Providers"; PRIVACY.md "Hosted servers").
  - No doc or test shows a scheduled run on a Codex subscription specifically [UNVERIFIED].
- **Self-hosted VPS: Yes, same mechanism.** It is always on, so no wake is needed (docs/self-hosted-server.md).

**F2. The ChatGPT-subscription crux (hosted)**

- **Token delivery:** device-code login run **on the hosted server**. "The sandbox browser is on Xvfb, where nobody can see it, so each sign-in finishes on the user's own device… Codex, Grok and Cline show a device code" (hosted-servers.md L303-311). The user enters the code on OpenAI's page from any device. The token isn't uploaded or pasted and isn't relayed through the laptop CLI, so it doesn't die when the laptop is off.
- **Storage:** the Codex CLI's `auth.json` under `CODEX_HOME` on the server's disk (provider-drivers.ts `codex` driver: `homeVariable: "CODEX_HOME"`, `signIn argv ["login"]`). That disk persists in the boat snapshot while the server sleeps (PRIVACY.md). OpenBot "does not read, copy or store" CLI credentials (provider-terms.md). The vendor Worker never holds the token ("its boat key cannot read them", PRIVACY.md).
- **Unattended refresh:** handled by the Codex CLI itself [INFERENCE; OpenBot docs don't describe Codex refresh]. A broken sign-in waits for a manual "Reconnect" (providers.md L1525). The docs give no Codex expiry interval [UNVERIFIED].
- **Where the model call comes from:** the server's own IP (boat EU or Leaseweb), through the Codex CLI. There is no vendor model proxy, so the request comes from a datacenter IP, not the user's home. OpenBot gives no OpenAI-specific ToS analysis; it says only "read what the provider says about third-party tools" (provider-terms.md "Other providers").
- **Credits:** none. "OpenBot does not sell, resell or pay for model usage" (provider-terms.md). The hosted plan "doesn't include AI model access" (guides/openbot-hosted-servers.tsx).
- **Plan restrictions:** I found no restriction on subscriptions on hosted servers. The only documented caveats are Gemini, which can't sign in headless, and the Claude ToS risk table.
- **Usage limit at 03:00:**
  - The plan usage limit holds that account/model until the reset. Codex usage-reset credits can be spent by the user (providers.md L1465).
  - Optional backup models, up to 8, take over automatically (L1411-1430).
  - The routine's `limitPolicy` is `wait` or `skip` (ipc-routines.ts).

**F3. Setup UX on the hosted plan** [INFERENCE: composed from documented steps]

1. Go to openbot.run/pricing and pick a hosted server. Starter (€16/mo yearly) is "Sold out"; Standard is €40/mo yearly. Pay in Stripe Checkout (AddServerOverlay; hosted-servers.md).
2. Open the server in the desktop, web (`openbot.run/app`) or phone client. The provider step shows a Codex device code; approve it on OpenAI's page with the ChatGPT account.
3. Create an agent from one prompt (homepage).
4. Say in chat "every night at 03:00 scrape X and save a CSV". The agent calls `create_routine` with a structured daily or cron schedule (`routine-tools.ts`); the routine UI and canvas work too. Timezone is the sender's client zone, else the server zone (routine-scheduler.ts). Set `missedPolicy`, `limitPolicy` and `runIn`.
5. **Human step:** sign in to site X once in the agent's browser via the live view. Cookies persist in the agent's partition. Alternatively, connect 1Password, Bitwarden or Proton Pass for secure-input fill. 2FA and CAPTCHA need a person (browser.md).
6. Test with "Run now" / `test_routine`.
7. Choose an output: attach to the reply, `send_to_channel`, or a workflow output to Slack, Discord or Telegram (connect via Marketplace → Apps).

- **Approvals:** the default is Full access, `approvalPolicy: never`, so the run isn't blocked unless the agent asks a question or the workflow has an approval step. Then it shows as `needs-attention` and waits.

**F4. Execution at 03:00 (hosted)**

- **Wake:** the server reports its next routine time (`hosted-server-activity.ts`). The Cloudflare Worker cron (`* * * * *`, apps/auth-api/wrangler.jsonc) starts the boat sandbox "a few minutes before its next scheduled routine run" (PRIVACY.md).
- **Firing:** the in-process `RoutineScheduler` single timer fires, and a fresh provider session runs (agents.md ~L166).
- **Scraping:** in the built-in Chromium (Electron `WebContentsView` on Xvfb, CDP tools), which handles JS-rendered pages. Alternatively the agent can use HTTP or code through Codex's shell [INFERENCE].
- **CSV:** written by Codex's shell or code tools into `~/OpenBot/Agents/<id>` [INFERENCE: no CSV tool], on the persistent server disk.
- **Cookies:** persist between nights in the `persist:` partition.
- **Failures:**
  - A bot wall or CAPTCHA gives `needs-user`, which in a routine run becomes a report (browser.md L189).
  - A provider error before any work fails over to a backup model; otherwise the run fails, with the error in run history.
  - I found no automatic retry [UNVERIFIED].
  - Completion notifications go to desktop and phone push.

**F5. Getting the CSV out**

- In the app: `attach_files_to_response` in the routine chat or thread, downloaded via file transfer to desktop, web or phone.
- Chat posts to Slack, Discord or Telegram (`send_to_channel` or a workflow output). File attachment delivery to those platforms is [UNVERIFIED].
- `publish_site` for a public static link (30-day expiry).
- Git push via shell.
- Email, Drive or Sheets would need an MCP or marketplace plugin, e.g. Composio, or Google's MCP servers via McpOAuth. Not documented for this flow [UNVERIFIED].
- I found no sync folder back to the laptop.

**F6. Gaps and risks**

- **Cost:** a flat €40/mo Standard (Starter sold out), not metered per run or hour. The nightly run uses the ChatGPT plan quota, not OpenBot credits. A commercial user also needs a license (€7.20/mo yearly, free until 2026-12-01). Self-host is €0 plus the VPS.
- **ToS:** the subscription is used from a datacenter IP in an unattended agent product. OpenBot disclaims and gives no OpenAI analysis; the risk is [UNVERIFIED].
- **Site blocking:** datacenter IP plus CAPTCHA means OpenBot only clicks checkboxes once, never solves challenges, and reports instead. A nightly run can yield no data.
- **Wake-up:** a failed wake or a start failure means a missed run; recovery depends on `missedPolicy` [INFERENCE].
- **Silent stoppers:** a lost Codex login needs a manual Reconnect, and `limitPolicy: skip` drops the run.
- **Isolation:** Full-access agents share one OS user and the default shared browser profile, and prompt injection from the scraped site is an acknowledged risk.
