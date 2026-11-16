# SuperBot research (2026-11-16)

Read at commit `652e100` (2026-11-15) of `davidondrej/superbot`, cloned and read in full: about 2,100 lines of Rust in `server/src/`, 1,000 lines of plain JS/HTML/CSS in `web/`, the docs, the three ADRs and `deploy/install-computer.sh`. Nothing was built or run. Line references are to that commit.

## What it is

- "Open-source, self-hosted Grok Bot alternative" (repo description). Named Bots, each with a chat, a Markdown memory file, cron routines and its own virtual screen, all on one Linux machine the user runs. The first Bot is the primary Bot that routes work to the others (README; `runner.rs:388-391`).
- Repo: https://github.com/davidondrej/superbot. MIT. Created 2026-11-15 17:30 UTC, last push 18:50 the same day; 107 stars, 31 forks, 0 issues, 4 open PRs from one outside contributor (GitHub API and `gh pr list`, 2026-11-16). All 25 commits are dated 2026-11-15. Status badge says "early".
- Company: none named. Single maintainer, David Ondrej. 107 stars and 31 forks in under a day more likely reflect his audience than adoption `[INFERENCE]`.
- The repo also ships `grok-bot-internals/` (8 pages) and `docs/background/`: their reconstruction of how Grok Bot works, tagged `[observed]` (what a Grok Bot reported about its own VM) or `[docs]` (docs.x.ai). Claims worth checking against our own notes: one Firecracker microVM per user shared by all Bots, one screen per Bot, chats and OAuth tokens kept outside the VM, Grok Bot built on Cursor's infrastructure with usage metered on the Cursor account (`grok-bot-internals/computer.md`, `models-and-platform.md`). Not verified here.

## Infra / self-hosting / laptop-off behavior

- One Rust binary, `botd` (axum, tokio, rusqlite), with the web app embedded via `include_str!` (`main.rs:212-237`). A second binary, `botctl`, is the CLI the Bots call (ADR 0001).
- Self-host only, on a Linux VPS. No hosted offering, no desktop app, no installer for `botd` itself: build with cargo, fill `.env`, run under systemd, put Caddy in front (`docs/backend.md`). `deploy/install-computer.sh` installs only the screen stack (Xvfb, Openbox, agent-browser, agent-desktop, voxl, 4 GB swap, earlyoom).
- Laptop off: works, because the VPS is the computer. No sleep/wake; the box is always on.
- State: SQLite (`data/app.sqlite`, WAL) for Bots, messages and routines; Markdown files for memory; harness session files wherever each CLI keeps them (`db.rs`; `docs/backend.md`). Schema migrations are `ALTER TABLE` calls whose errors are ignored (`db.rs:165-166`).
- Isolation: none between Bots. "Screens are not security boundaries. All Bots share one Linux user" (ADR 0003). All Bots share one working folder, `WORKSPACE_DIR`, and the system prompt tells them so (`runner.rs:398-399`).
- Restart: queued messages run after a restart; a task that was running is reported as interrupted and not re-run, "so it can't repeat an action like sending an email" (`runner.rs:368-382`).

## Claude / Codex subscription use

- Yes. Each Bot runs on a harness CLI the operator installed and logged in as the user that runs `botd`: `claude`, `codex` or `pi` (`docs/backend.md`). No OAuth, token storage or refresh of their own; the CLIs keep their own logins.
- Claude Code: `claude -p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <system> --session-id|--resume <id>` (`adapters/claude.rs:18-33`). The model list is hard-coded (`claude.rs:66-79`).
- Codex: `codex exec [resume] --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -c developer_instructions=<system>` (`adapters/codex.rs:15-33`). Codex reads developer instructions only when a session starts, so later memory edits reach it only through the file (`codex.rs:1-3`).
- Pi: `pi --mode json --session-dir <bot dir>/pi-sessions --session-id <id> --append-system-prompt <system>` (`adapters/pi.rs`).
- Per-Bot model and reasoning effort, passed as CLI flags (`--model`/`--effort`, `-m`/`model_reasoning_effort`, `--model`/`--thinking`). Codex models come from `codex debug models`, Pi's from `pi --list-models`.
- No fallback on a plan limit, no retry: a harness error becomes an error bubble (`runner.rs:258-268`). One automatic retry with a fresh session only when the CLI reports its session lost (`runner.rs:245-256`).
- ToS: not discussed anywhere in the repo. One operator login is shared by every Bot.

## MCPs / apps / integrations

- No MCP client or server. ADR 0003: tools are CLIs "so every harness can use them without an adapter change. No MCP." The harness CLIs can still load whatever MCP servers the operator configured for that login `[INFERENCE]`.
- No app connectors, no Composio, no OAuth apps. Planned: Slack.
- Channel: the embedded web app only (desktop browser; a mobile-layout PR is open).
- Bot to Bot: `botctl ask "<Bot>" "<message>"` blocks up to 9 minutes; a later reply is queued as a new message to the asker (`main.rs:400-420`; `runner.rs:279-331`).
- Choice cards: a reply ending in a fenced `question` JSON block becomes a multiple-choice card (`runner.rs:447-456`). Harness-neutral, no tool call needed.

## Monetization

- None. MIT, no hosted plan, no sponsors listed.

## Differentiator

- Smallest working codebase in the category: one Rust binary, three harnesses behind a 4-method `Adapter` trait (`adapters/mod.rs:44-52`), SQLite, no Node or Docker on the server.
- Harness-agnostic by construction: tools are shell CLIs (`botctl`, `agent-browser`, `agent-desktop`) explained in the system prompt, so any harness that can run a shell can use them.
- Per-Bot virtual screen with live view and takeover (voxl), on day one.
- Weaknesses: no permission model at all (every harness runs with approvals and sandbox off), no isolation, no secrets handling, single-password auth, one test, one day old.

## Tech stack

- Rust 2024 edition, Cargo workspace; deps: axum 0.8, tokio, rusqlite (bundled), serde, chrono (`server/Cargo.toml`). Base64 decoding, cron parsing and `botctl`'s HTTP/1.0 client are hand-written to avoid dependencies.
- Web: one `index.html`, `app.js` (~570 lines, no framework, Markdown escaped before formatting, `app.js:53`), `styles.css`. One SSE stream (`/api/events`) with a `resync` event when a slow client drops events (`main.rs:239-247`).
- Screen stack: Xvfb + Openbox + per-screen D-Bus, agent-browser v0.43.0 (headed Chrome for Testing, AppArmor profile instead of `--no-sandbox`), agent-desktop v1.3.1 (AT-SPI), voxl 0.3.5 built from source (`deploy/install-computer.sh`).
- Tests: one unit test, for cron matching (`cron.rs:77-93`). No CI config found.

## Sources

- https://github.com/davidondrej/superbot at `652e100`: `README.md`, `AGENTS.md`, `.env.example`, `docs/architecture.md`, `docs/backend.md`, `docs/computer.md`, `docs/adr/0001-backend.md`, `0002-name.md`, `0003-computer.md`, `docs/background/*`, `grok-bot-internals/*`, `deploy/install-computer.sh`, `server/src/{main,runner,db,cron,screen}.rs`, `server/src/adapters/{mod,claude,codex,pi}.rs`, `server/src/bin/botctl.rs`, `web/app.js`.
- GitHub API (`repos/davidondrej/superbot`) and `gh pr list`, read 2026-11-16.

## A. Agent browser

- Engine: Vercel `agent-browser` as a CLI, Chrome for Testing installed for the `botd` user. Desktop apps through `agent-desktop` over the screen's accessibility bus (`docs/computer.md`).
- Where: headed on the Bot's own Xvfb display on the VPS. `botd` starts a screen on the Bot's first task (or when the user opens the live view) and stops it after `SCREEN_IDLE_MINUTES` (default 10). At most `MAX_SCREENS` (default 3); when full, the least recently used screen of an idle Bot is stopped, else the request fails (`screen.rs:78-107`).
- Profiles: one per Bot in `DATA_DIR/bots/<id>/browser`, set through `AGENT_BROWSER_SESSION`/`AGENT_BROWSER_PROFILE` env; the prompt tells the Bot never to pass `--session` or `--profile` (`screen.rs:175-191`; `runner.rs:484`). Nothing enforces it: same OS user, so any Bot can open another Bot's profile directory.
- Takeover: voxl serves each screen on `127.0.0.1:6800+n`, view-only until the user clicks Take over; the proxy routes `/screen/<port>/`. Access is a 16-byte token in the URL query (`?token=…`) checked by voxl, not by `botd`'s auth (`main.rs:424-432`; `docs/computer.md`).
- Login: `botctl handoff "<what you need>"` posts a card with Open screen / Done and blocks the Bot's shell command up to 9 minutes; after that the answer arrives as a new message (`main.rs:434-445`; `runner.rs:292-307`). The prompt says "Never ask for passwords in chat" (`runner.rs:486`). No vault, no secret typing.
- Stealth: none beyond headed Chrome on a real display. No egress control.

## B. Credentials and secrets

- No vault, no secret store. Planned ("Vault for secrets", `docs/backend.md`).
- Harness logins: in the CLIs' own stores in the `botd` user's home, readable by every Bot's shell. Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) "pass through to the Bots" as env (`docs/backend.md`).
- **`botd`'s whole environment reaches every Bot.** The harness is spawned with `Command::new(...).envs(&input.env)` and no `env_clear` (`adapters/mod.rs:134-147`), and the documented start is `set -a; . ./.env; set +a; ./target/release/botd`. So `AUTH_PASSWORD`, the browser login, is in every Bot's environment.
- **One bearer token for all Bots, with full API access.** `bot_token` is generated once per start (`main.rs:86`), given to every run as `BOT_TOKEN` (`runner.rs:188-192`), and the auth middleware accepts it for every `/api` route (`main.rs:177-191`). The calling Bot's identity is the `from` field it sends (`main.rs:403`, `437`). A Bot can therefore read every chat, post a message as the user to any Bot (`POST /api/bots/:id/messages` stores role `user`), delete or re-harness Bots, and edit or delete any Bot's routines (`botctl routine rm <id>` is not scoped to the caller, `botctl.rs:78`).
- Browser auth: HTTP Basic, any username, one password; refused to listen on a non-loopback address without it (`main.rs:60-63`). With no password on loopback every request is accepted (`main.rs:180`). No Host or Origin check, so a DNS-rebinding page could reach a loopback `botd` without a password `[INFERENCE, not tested]`.
- Prompt-injection defences: none. The system prompt says "Ask before anything you can't undo" (`runner.rs:419`), but with permissions skipped that is advice to the model, not a control. Peer messages from other Bots run with the same full access.
- Memory: "Never store passwords, keys, or card numbers" in the prompt (`runner.rs:404`). The whole `MEMORY.md` and `USER.md` are inlined into the system prompt every run with no size cap (`runner.rs:405-411`); open PR #1 adds a cap.

## C. Crons / scheduling

- Engine: in-process tokio loop, ticks every 15 s, hand-written 5-field cron parser (`*`, lists, ranges, steps, classic day-of-month OR weekday) (`cron.rs`).
- State: `routines` table in SQLite with `last_run_at`; a routine fires at most once per matching minute (`cron.rs:55-74`).
- Time zone: the server's local time (`TZ`), one for all routines (`.env.example`). DST: matches local wall-clock minutes, so a time in the skipped spring hour never fires and one in the repeated autumn hour fires twice `[INFERENCE from cron.rs:46-53, 64]`.
- Missed runs: none caught up. A minute the server was down is simply never matched again. No "missed" record.
- Overlap: a fired routine is a queued message in the Bot's FIFO, behind any user messages; one task per Bot at a time (`runner.rs:122-161`).
- Retry: none. Run timeout `RUN_TIMEOUT_MINUTES` (default 60) kills the process group (`runner.rs:182-186`).
- Who creates schedules: Bots, via `botctl routine add`, including from a routine run or a peer message. The user can also create them over the API.
- Triggers: cron only. No webhooks, email or app events.

## D. Stack scope

- One process on one VPS: web server, scheduler, runner, screen supervisor. External processes per run: the harness CLI, and per screen Xvfb, dbus-daemon, Openbox and voxl, all `kill_on_drop` (`screen.rs:109-145`).
- Runs as a normal user, not root, because Claude Code refuses `--dangerously-skip-permissions` as root (`docs/backend.md`).
- Sizing claim: "A 2 CPU, 8 GB server handles about 3 screens at once"; one Bot with Chrome ~0.5-1 GB; a busy stream ~1 core (`docs/computer.md`). No per-Bot memory limits; swap and earlyoom (prefers killing Chrome) are the safety net (ADR 0003).

## E. Sandbox / agent computer: what it is used for

- The "computer" is the VPS itself as one Linux user: shared `WORKSPACE_DIR`, shared home with every CLI login, plus per-Bot screens and browser profiles. It copies Grok Bot's model as they reconstruct it (one shared machine, screens are not boundaries) without the microVM around it.
- Intended uses (README): Developer, Researcher and Inbox Bots; browser and desktop-app work; Bot-to-Bot delegation. No app connectors, so inbox-style work needs the browser or a CLI the operator installed.
- Files: no upload or download in the UI; voxl file transfer is off (`screen.rs:139`). Output is chat text or files in the workspace.

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

- Verdict: partly, self-host only. Log `codex` in on the VPS as the `botd` user, create a Codex Bot, sign in to the site once through `botctl handoff` and the live view, then have the Bot add `0 3 * * *` with `botctl routine add`.
- What can fail: the server down or restarting at 03:00 (no catch-up, no record); a CAPTCHA or expired cookie (the handoff waits 9 minutes, then the run ends and the answer arrives as a new message hours later); a Codex plan limit or expired login (error bubble, no retry or fallback); DST moving the run if `TZ` observes it.
- Nothing pauses for approval, so a CSV write or an email goes out unattended; equally, nothing stops an injected page from doing anything the `botd` user can.
- The CSV lands in `WORKSPACE_DIR`; the user sees the Bot's chat reply. No download in the UI.
