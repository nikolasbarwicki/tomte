# Plan: from my Grok Bot replacement to a product for business owners

Status: draft

Statuses updated 2026-11-19. Fresh `tomte` runs on my VPS (`claudebot` removed). Step 4 (routines from chat) and Chief of Staff passed live; Steps 1 and 5 are mostly verified live on the VPS. What is left in Stage 1's gate is listed under [The cancel gate](#the-cancel-gate).

Amended 2026-11-17: the credential vault was removed (`.scratch/remove-credential-vault/`). Where this plan says a routine signs in with a granted vault entry (the parity row "Sign in once", gate step 1, Decisions 4 and 5), that no longer holds: logins come from takeovers only, and a routine on a sign-in page reports the source as unavailable.

Tomte is a side project and a portfolio piece. It grows in three stages, and each stage is useful on its own:

1. **My Grok Bot replacement.** Every Grok Bot feature my routines use works for me, including routines that run while my laptop is off. It runs on the VPS I already rent, so it costs nothing on top of the Claude plan I already pay for.
2. **Published.** Anyone can self-host it with one command. The repository, the docs and a demo show the work to employers and future partners.
3. **A product.** A hosted version for business owners, priced like competitors ($15, $49 and $99 a month). The company brain sets it apart.

Competitor research is kept outside the public repository. Grok Bot facts come from its docs at `docs.x.ai/grok-bot` and from `x.ai/bot`, read on 2026-11-14. Vendor prices are list prices from the same day.

## The differentiator: a company brain

Grok Bot gives each bot its own memory, plus a few facts about you that every bot shares. There is no memory screen. Its docs say "Memory is not a source of truth" and tell you to keep changing facts in other systems. Its bots also share one computer, and "Files and sign-ins on the shared computer aren't isolated per Bot".

A business owner needs the opposite: one place that holds the business, which every bot reads, which cites where each fact came from, and which no bot changes without permission. That is the company brain:

- the company profile, the offer and prices, and the tone of voice;
- customers, suppliers and people;
- processes, decisions and their reasons.

Two competitors come close. Turnstone keeps a shared "Brain" of plain files, but it is a closed Mac app with no laptop-off mode. agentes.chat has a wiki, a drive and memory, but it is built as team chat. Neither aims at business owners. [Decisions B1 to B5](#company-brain-decisions) cover the design.

## Grok Bot parity

"Stage" says when the gap closes. "Not planned" marks features that matter only to teams.

"Status" says where the feature stands on master: ✅ "Done", 🧪 "Done, needs my check" (the code shipped and waits on the live check named in Gap), 🟡 "Partly done" (Gap says what is left), ❌ "Missing" or ⚪ "Not planned".

| Grok Bot feature                                                           | Status                  | Tomte today                                                                                                                                                                | Gap                                                                                         | Stage                     |
| -------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| Bots with a name, a job, memory and a picture                              | ✅ Done                 | Bots, bot memory, user memory and avatars                                                                                                                                  | None                                                                                        | Done                      |
| A primary bot that coordinates the others                                  | ✅ Done                 | Handoffs between bots (ADR 0002), Chief of Staff switch on a bot's Profile page, `create_bot` behind approval, and phone `@Name` (`d7bf397`; live check passed 2026-11-19) | None                                                                                        | Done                      |
| A computer with a browser, files and a terminal                            | ✅ Done                 | One browser session and files area per bot, with every shell sandboxed                                                                                                     | None, and stronger isolation than Grok Bot's one shared computer                            | Done                      |
| Works while the laptop is closed                                           | 🧪 Done, needs my check | Fresh `tomte.service` runs on my VPS (2026-11-19) on my tailnet only, with Claude signed in, Telegram linked and Chrome working                                            | Set up the five routines + integrations and run a week with the laptop closed (gate step 2) | 1                         |
| Sign in once, with a vault and a secure handoff                            | 🧪 Done, needs my check | Takeovers park and resume (vault removed in `f95d6cd`; sign-in pages in routines skip as unavailable; login/bot walls and restart verified 2026-11-19)                     | My interactive phone takeover check (parking 08 / Telegram 07)                              | 1                         |
| Apps such as Gmail, Calendar, Drive, Slack and Notion, plus any MCP or API | ✅ Done                 | 30 catalog entries and custom integrations                                                                                                                                 | None for my use                                                                             | Done                      |
| Skills, saved from a finished task                                         | 🟡 Partly done          | Installable skills (`integrations/skills.ts`)                                                                                                                              | Bots cannot save a skill. Roadmap item 8                                                    | 1, after the gate         |
| Routines on a schedule, in a time zone                                     | ✅ Done                 | `Bun.cron` with a time zone, run history at `/api/routines/runs`                                                                                                           | None                                                                                        | Done                      |
| Ask in chat to create, edit or pause a routine                             | ✅ Done                 | `create_routine`, `list_routines` and `update_routine` host tools (`mcp__routines__*`). `update_routine` pauses and resumes                                                | None (live check passed 2026-11-19)                                                         | Done                      |
| Test a routine now                                                         | ✅ Done                 | Manual runs (`RunTrigger` `manual`)                                                                                                                                        | None                                                                                        | Done                      |
| Triggers from webhooks, email, Slack, GitHub, Linear, Sentry and PagerDuty | 🟡 Partly done          | External events at `POST /api/bots/<id>/events`, which are not routine triggers                                                                                            | Webhook trigger (roadmap item 2) and a bot email address                                    | 1, after the gate         |
| Approval before sending, buying or deleting                                | 🧪 Done, needs my check | `off`, `ask` and `auto` per tool. An unattended run parks on an approval and resumes on my answer, with "always allow" on the card                                         | My check that I approve an email from my phone (Telegram 08)                                | 1                         |
| Phone app and Slack                                                        | 🧪 Done, needs my check | Web UI, the desktop app and a linked Telegram channel for Needs-you cards, approvals, notices and routine results                                                          | My phone takeover and cancel-gate checks (Telegram 07 and 08). No Slack app                 | 1                         |
| Voice notes                                                                | ❌ Missing              | None                                                                                                                                                                       | Transcribe voice notes sent through the phone channel                                       | When a routine needs them |
| Teach a task by demonstration                                              | ❌ Missing              | None                                                                                                                                                                       | Record a takeover and turn it into a skill draft                                            | 2                         |
| Documents, decks and live Pages                                            | ⚪ Not planned          | The Files panel. Decks through skills                                                                                                                                      | No live Pages                                                                               | Not planned               |
| Pause routines after a long absence                                        | 🧪 Done, needs my check | `pauseAfterAbsenceDays` with a warning 2 days before. My VPS uses 14                                                                                                       | My check that its notice card reaches my phone (cost guards)                                | 1                         |
| Import memory from another assistant                                       | ❌ Missing              | None                                                                                                                                                                       | An import prompt that writes to the brain                                                   | 2                         |
| Bot templates and a marketplace                                            | ❌ Missing              | None. Templates are roadmap item 6b                                                                                                                                        | Templates, plus a Grok Bot importer                                                         | 2                         |
| Team Bots, group chats, Slack and Teams for teams, meetings                | ⚪ Not planned          | None                                                                                                                                                                       | Teams are deferred in `docs/roadmap.md`                                                     | Not planned               |

## Stage 1: my Grok Bot replacement

Stage 1 runs on the OVH VPS I already rent (Ubuntu 26.04, 4 GB of memory, 2 GB of swap). It is the only host my bots run on: the desktop app connects to it as a remote profile, and the laptop's host is for development. The bots are set up fresh on the VPS, with no migration tool.

### My routines

| Routine              | Schedule                            | Sources and tools                                                                                                                                                                                                                                                                                                                                                                  | Policies                                                               |
| -------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inbox organizer      | Daily                               | Gmail                                                                                                                                                                                                                                                                                                                                                                              | Label and archive `auto`. Send and delete `off`                        |
| Job scout            | Monday and Thursday (`0 8 * * 1,4`) | LinkedIn's public job search without a login, for remote AI product and applied AI roles in Poland or the EU. justjoin.it, nofluffjobs and theprotocol for salaries in PLN. Jobgether, Remote Rocketship and Wellfound, then the posting on the company's own site. Hacker News "Who is hiring" through the HN Algolia API. Web search for funding news and founders' hiring posts | Read only. No X login. A message to a founder is a draft I send myself |
| Outreach researcher  | Daily                               | Web search, company sites and the Hostinger email MCP                                                                                                                                                                                                                                                                                                                              | Every send asks and parks                                              |
| Calendar planner     | Weekly                              | Google Calendar                                                                                                                                                                                                                                                                                                                                                                    | Events on my own calendar `auto`. Invites and deletes `ask`            |
| Coding retrospective | Weekly                              | GitHub commits, pull requests and issues                                                                                                                                                                                                                                                                                                                                           | Outside the gate                                                       |

- Schedules are staggered so that no two runs overlap, because each bot that browses runs its own Chrome, and the VPS has 4 GB.
- Bots fetch APIs and JSON first and open Chrome only when a page needs it. Each bot's purpose says so.
- The scout and the researcher keep `seen.jsonl` in their files area (URL or company, date, outcome). They read it before a run and append to it after, so nothing is reported or contacted twice. The brain's customer and people pages can take this over later.

### The cancel gate

Each step ends with a check. When all five checks pass, I can cancel Grok Bot.

**Gate status (2026-11-19): code done for all five steps; Step 4 passed; Steps 1 and 5 mostly verified live on the VPS.** Remaining: interactive phone takeover & email approval checks (Steps 1 & 3), a real notice card on Telegram (Step 5), and Step 2's 1-week soak with the five routines.

1. **Unattended runs that park.** Approvals, takeovers and questions park and resume ([Decision 3](#3-approvals-in-unattended-runs)). Logins come from takeovers only; sign-in pages in routines skip as unavailable (`f95d6cd`). Bot walls are detected and handed off ([Decision 5](#5-bot-walls)). **Status: 9/13 live checks passed (2026-11-19).** Verified live on `vps.tail3b8f5e.ts.net` (`docs/plans/unattended-parking/issues/08-gate-check-expired-login.md`): `ask_user` park & resume, skipped occurrence while parked, background-tasks headless routine, `systemctl restart tomte` resilience (question stays `waiting`, takeover cancels cleanly), 24h expiry, login wall (`Unavailable:`), DataDome bot wall, and 4 GB VPS memory (`609.2M` / peak `683.2M`, `2.6 GiB` free). Still open: interactive phone takeover completion and an `ask`-policy integration tool approval (`Allow`, `Deny` with note, `Always allow` + remove).
2. **My VPS.** `deploy/install.sh` under its own user, AppArmor `userns` profiles for `bwrap` and Chrome (`tomte-chrome`, folded into `deploy/install.sh` 2026-11-19), and `tailscale serve` for tailnet-only HTTPS. Check: a week of all five routines with the laptop closed, and no missed run. **Status: fresh `tomte` installed (2026-11-19), waiting for routines + 1-week soak.** `claudebot` was removed and replaced with `tomte.service` (`TOMTE_PAUSE_AFTER_ABSENCE_DAYS=14`, Claude CLI `2.1.328` signed in, Chrome `158` working, Telegram linked). The week starts once the five routines and integrations are configured there.
3. **My phone.** A Telegram channel for Needs-you cards, approvals and routine results ([Decision 6](#6-reaching-me-on-my-phone)). Check: I approve an email from my phone while the laptop is closed, and the run finishes. **Status: code done, waiting for my live checks.** Telegram is linked on the fresh `tomte` VPS and wait cards arrive on the phone. The step passes when I have run `docs/plans/telegram-channel/issues/07-phone-takeover-check.md` and `08-cancel-gate-phone-check.md` and recorded the results there.
4. **Routines from chat.** `create_routine`, `list_routines` and `update_routine` host tools (roadmap item 3, routines only). Check: "brief me every weekday at 8" in chat creates the routine. **Status: passed (2026-11-19).** Verified live on `vps.tail3b8f5e.ts.net` with Claude CLI `2.1.328` (`docs/plans/routines-from-chat/issues/04-gate-check-brief-me-every-weekday.md`): created `0 8 * * 1-5` (`Europe/Warsaw`), paused, resumed, and confirmed cross-bot isolation.
5. **Cost guards.** Usage records, a time cap per run, auto-pause after failures and an absence pause ([Cost guards and usage](#cost-guards-and-usage)). Check: a looping routine pauses itself and tells me. **Status: 2/3 live checks passed (2026-11-19).** Real run costs (`$0.0142`–`$0.0776`) and pause/resume firing on schedule (`1483bf4e` → `0a22e9d2`) verified live on the VPS. Still open: confirm a real auto-pause or absence notice card arrives on Telegram.

### After the gate

In this order:

1. **Company brain v1.** A `brain/` folder, search tools, proposals that need approval, and an interview that fills it ([Decisions B1 to B5](#company-brain-decisions)). Check: a new bot answers "what do we charge for X and why" from the brain and cites the page.
2. **A Chief of Staff** (`docs/plans/chief-of-staff/spec.md`). **Done (2026-11-19):** shipped in `d7bf397` (switch on a regular bot, `create_bot` behind an approval card, `@Name` from Telegram to any bot) and verified in `docs/plans/chief-of-staff/issues/04-owner-live-check.md`.
3. **Triggers.** A webhook trigger (roadmap item 2), a bot email address ([Decision 7](#7-a-bot-email-address)) and the `untrusted` flag ([Decision 3](#3-approvals-in-unattended-runs)). Both triggers need the host reachable from outside my tailnet, through Tailscale Funnel for those routes or Caddy and a domain. Check: a forwarded invoice email starts a routine that files it, and a write inside it parks.
4. **A laptop digest for the coding retrospective.** A script on the laptop posts a weekly digest of my Claude Code sessions to the bot's events route.

Voice notes wait until a routine needs them.

## Stage 2: published

1. **License** ([Decision 8](#8-license)). **Done on `open-source-launch`:** `AGPL-3.0-only` + CLA (ADR-0013, superseding FSL below).
2. **One-command self-hosting.** `deploy/install.sh` for any Linux server, proven on my VPS in Stage 1, plus Caddy and a domain for public HTTPS.
3. **Signed macOS desktop app.** `AGENTS.md` already lists the signing and notarization steps.
4. **Templates and a Grok Bot importer.** A shared Grok Bot template link exposes the bot's identity, description, skills and routines. The importer maps those to a Tomte bot, its skills and its routines.
5. **Teach by demonstration.** Record a takeover and draft a skill from it.
6. **Showcase.** The README with a demo video, `docs/provider-terms.md` and an architecture page that links the ADRs.

Check: a stranger self-hosts it from the README alone, and imports a Grok Bot template.

## Stage 3: a product for business owners

1. **Terms.** Email Anthropic sales about hosting the unmodified Claude Code binary for paying customers ([Decision 9](#9-model-access-and-terms)).
2. **Design partners.** First, machines that sleep: a Dockerfile ([Decision 2](#2-the-container-image)), an idle exit, a Cloudflare Worker that wakes the machine before routines, and Telegram over a webhook ([Decision 1](#1-where-the-host-runs)). Then run 3 to 5 business owners, one Fly Machine each, provisioned by hand. Measure awake hours, expired logins, sites that block the IP, and what they keep in the brain.
3. **Control plane.** Accounts, provisioning, wake and backups ([Decisions 10 to 14](#10-control-plane)).
4. **Billing and launch.** [Decisions 15 and 16](#15-billing). Check: a stranger signs up, pays, fills the brain through the interview, and a routine runs while their laptop is off.

## Stage 1 decisions

### 1. Where the host runs

Stage 1 runs on the OVH VPS I already rent, always on. It costs nothing extra, and `deploy/install.sh` needs no new code.

The comparison below is for Stage 3, where each design partner and customer gets a machine that sleeps between uses. The costs are for one user, about 15 hours awake a month: one daily routine with its wake margin, and a few phone approvals.

| Option                                                    | My monthly cost                                                                           | New code                                                                                                     | Data across sleep                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Fly Machine, shared-cpu-2x with 4 GB, plus a 10 GB volume | About $2.30: $0.53 compute, $1.50 volume and about $0.30 for the stopped root filesystem  | A Dockerfile, an idle exit, and a Worker cron for scheduled wakes                                            | The volume keeps everything                                                               |
| boat.dev `small` (2 vCPU, 4 GB)                           | $20, the smallest plan, paid in advance as machine time                                   | A wake controller, idle stop, and a hook that closes SQLite before every stop                                | The disk is kept, but it is saved file by file, which corrupted OpenBot's SQLite database |
| Cloudflare Container `standard-1`                         | About $5.40: $5 Workers Paid covers the Worker, the alarms and most of the container time | A Dockerfile, a save of the data root to R2 at every sleep and a restore at every wake, and keep-alive pings | The disk is wiped at every sleep. Whether bubblewrap works is undocumented                |
| Hetzner CX23, always on                                   | €5.99 plus an IPv4 fee                                                                    | None. `deploy/install.sh` works today                                                                        | Normal disk                                                                               |
| A VPS I already rent (OVH), always on                     | Nothing extra                                                                             | None. `deploy/install.sh` works today                                                                        | Normal disk                                                                               |
| My laptop only (until 2026-11-16)                         | $0                                                                                        | None                                                                                                         | Misses every run while the laptop stays closed                                            |

**boat.dev for one user.**

- Pros:
  - The cheapest hour once you have many machines.
  - A full VM with root, plus Docker and Chrome preinstalled.
- Cons:
  - A $20 minimum makes it the most expensive option for one user.
  - No wake on an inbound request, and no idle stop. Its auto-stop is a fixed timer.
  - SQLite needs an undocumented pre-stop hook.
  - The IP changes on every resume.
  - OpenBot now prefers an always-on VPS pool over boat.

**Fly Machine with a volume.**

- Pros:
  - The cheapest for one user.
  - The volume keeps the data root, so nothing is restored and SQLite closes normally on exit.
  - Fly's proxy starts a stopped machine when a request arrives, so opening the UI or a Telegram webhook wakes it with no code. At one machine, the slowness Fly warns about at thousands of machines does not matter.
  - The same shape serves each customer in Stage 3.
  - A static outbound IP costs $3.60 a month if sites start asking for logins again.
- Cons:
  - Needs a Dockerfile, and bubblewrap inside Fly's VM must pass a spike [inference: a full VM kernel allows it].
  - Scheduled wakes need an outside caller, because the proxy wakes only on requests.
  - A cold start is about 2 seconds plus the host's own start.
  - The volume lives on one host, so it needs a nightly backup.

**Cloudflare Container.**

- Pros:
  - One vendor and one bill for everything.
  - $0 while asleep.
- Cons:
  - The disk is wiped at every sleep, so the database, the secrets, every Chrome profile and the Claude sign-in travel to R2 and back on every wake.
  - The per-user mode is in beta.
  - Whether bubblewrap works is undocumented.

**Pick for Stage 3:** a Fly Machine with a volume. The host exits after 15 minutes with no use, unless a routine starts within 10 minutes. A parked run does not keep the machine awake; only a running turn does. Before it exits, it closes the database and sends its next wake time (`min(nextRunAt) - 10 min`) to a Cloudflare Worker. The Worker's cron runs every minute and starts the machine through the Fly API when that time comes. `claimOccurrence` makes a double wake harmless. `reconcile()` runs the latest missed occurrence within 12 hours when the routine has catch-up on, and records older ones as skipped. Telegram moves from long polling to a webhook, so a message wakes the machine. The Fly secret holding the secrets key is written to a tmpfs file at boot, because the host reads that key only from a file (`--secrets-key-file`). A nightly `VACUUM INTO` copy plus a tar of the data root goes to R2.

Cloudflare stays in the design as the wake service and the control plane in Stage 3. It is what Cloudflare does best here.

### 2. The container image

Needed once machines sleep, in Stage 3. Stage 1 installs with `deploy/install.sh`.

| Option                                                                                                  | Pros                                                  | Cons                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| A Dockerfile that copies the compiled host and the bundled browser engine (`scripts/browser-bundle.ts`) | Pinned Chrome, and the same binary as the desktop app | A large image, about 200 MB zipped for the browser alone   |
| A Dockerfile that runs `install-cli` and `install-browser` at first boot onto the volume                | A small image                                         | The first boot needs the network, and Chrome is not pinned |
| Nix                                                                                                     | Reproducible                                          | A new tool for this repository                             |

**Pick:** the compiled host plus the bundled engine and Chrome, with `bwrap` and `socat` from the distribution. The Claude CLI installs onto the volume with `install-cli`, so its sign-in and updates survive.

### 3. Approvals in unattended runs

| Option                                                                             | Copy from           | Pros                          | Cons                                                           |
| ---------------------------------------------------------------------------------- | ------------------- | ----------------------------- | -------------------------------------------------------------- |
| Park the run and resume it on an answer                                            | Rerun, agentes.chat | Nothing fails silently        | The machine must wake for the answer                           |
| Allow and block lists built from earlier approval cards                            | Rakazo              | Fewer interruptions over time | A broad rule can approve too much                              |
| Grok Bot's "smarter approvals", where the model judges what was already authorized | Grok Bot            | The fewest interruptions      | The model decides what is safe, and an injected page can argue |
| Full access by default                                                             | MausBot, OpenBot    | No interruptions              | One injected page acts with every permission                   |
| Deny everything (until `437dcfd`)                                                  | None                | Safe                          | Any routine that needs one approval fails                      |

**Pick:** park and resume, plus "always allow this for this bot" on the card.

- Every Needs-you item (an approval, a takeover, an `ask_user` question, a login approval) is a row in one `human_waits` table: kind, bot, run id, session id, payload and expiry. The web UI, every channel and the expiry check read it, so nothing is lost on a restart or a deploy. This shipped in `437dcfd`; before it, these lived in memory.
- Parking ends the run's turn and sets a new `waiting` run status. That needs a contract change and a rebuild of the `routine_runs` table, whose status CHECK cannot be altered. An answer resumes the session with a message, as ADR 0002 has tools return at once and events arrive as messages, so earlier steps do not run again.
- A park expires after 24 hours, whatever started the run. The run then fails with "approval expired", and I am told. Roadmap item 1's 30 minutes would end every night-time park before I wake up.
- While a run is parked, occurrences that come due are skipped with "previous run is waiting for you", so two runs never share a session.
- An approval covers exactly the input on the card. A send to someone else needs no rule of its own: it is the default `ask` policy, and "always allow" is my explicit choice for any tool. The code keeps no list of which tools send.
- The triggers milestone adds an `untrusted` flag, stored on runs and turns started by a webhook, an email or `POST /api/bots/<id>/events`. Under it, every `auto` integration tool asks, and "always allow" does not apply. Whether the host-served tools (`mcp__host__*`, `mcp__browser__*`, `mcp__bots__*`, `mcp__routines__*`) also ask is decided then (`docs/research/webhook-research.md` proposes they do). Today nothing marks such a turn, and `auto` tools run freely in it. Browsing does not set the flag: every routine that browses reads untrusted pages, so tool policies are the defence there.

### 4. Logins inside routines

| Option                                    | Copy from                                                    | Pros                                 | Cons                                                                     |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| Allow vault entries I already granted     | Rakazo                                                       | Most expired sessions fix themselves | A routine signs in with nobody watching, though the grant was my consent |
| Takeover parks the run and pings my phone | Rakazo `request_takeover`, agentes.chat `browser_ask_person` | Covers 2FA and CAPTCHA               | I must act before the result is useful                                   |
| Refuse both (until `437dcfd`)             | None                                                         | Simple                               | A nightly scrape fails on its first expired login                        |

**Pick:** both of the first two. A routine uses a granted vault entry unattended only after I approved its first use interactively (`login.ts` asks on first use). A first use or a new grant parks. This shipped in `437dcfd`; before it, `browser_login` refused every unattended run, granted or not.

### 5. Bot walls

| Option                                                                   | Copy from                          | Pros                             | Cons                                          |
| ------------------------------------------------------------------------ | ---------------------------------- | -------------------------------- | --------------------------------------------- |
| Detect Cloudflare, DataDome, PerimeterX and Imperva, wait, then hand off | Rerun `tools/bot-wall.ts`, OpenBot | Honest, and no site terms broken | Some sites never pass                         |
| A stealth browser (patchright)                                           | Rerun                              | More sites pass                  | An arms race, and it may break site terms     |
| A CAPTCHA-solving service                                                | None                               | Unattended                       | Breaks most sites' terms, and costs per solve |
| Residential proxies                                                      | None                               | Looks like a home user           | Expensive, and a legal gray area              |

**Pick:** detect, wait, hand off. A page that asks for a login, on a site where the bot has no granted vault entry, is "source unavailable": the run skips it and says so in its report, without parking. LinkedIn's sign-in wall for datacenter IPs is the common case, but the code names no site. No proxies.

### 6. Reaching me on my phone

| Option                                     | Copy from         | Pros                                                                                                      | Cons                                                                                                                |
| ------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A Telegram bot                             | OpenBot           | Free, buttons that edit the message in place, voice notes built in, and its webhook wakes the Fly machine | Needs Telegram                                                                                                      |
| Web Push to the web UI installed as an app | None              | No third party                                                                                            | On iOS it works only after "Add to Home Screen", and Apple revokes a subscription when a push shows no notification |
| A Slack app                                | Grok Bot, OpenBot | Where teams already work                                                                                  | Needs a Slack workspace, and is overkill for one person                                                             |
| A native iOS app                           | Grok Bot          | The best experience                                                                                       | Months of work, and App Store review                                                                                |

**Pick:** Telegram first, as the first adapter of a channel interface. Web Push in Stage 2.

- A channel does three things: it delivers a Needs-you item, delivers a routine result, and routes an answer back through the same answer path as the web UI (`docs/plans/answer-path-and-relay.md`). WhatsApp, Slack or Web Push are later adapters.
- Linking: the web UI shows a one-time code, I send it to the bot, and the host stores my user id. Updates from anyone else are ignored. The bot token lives in the secrets backend. Each customer has their own host, so the same linking serves Stage 3.
- Telegram updates arrive by long polling, because the VPS is always on. Handling them does not depend on the transport; a webhook comes in Stage 3, when machines sleep.
- A card has buttons and a link to the web UI, and long input is cut short with that link. Free text only answers an open card. Telegram never edits what an approval covers; to change it, I deny with a note or edit in the web UI.
- It sends every Needs-you item, an expired park, a failed run and an auto-pause, plus a short result with a link for routines that opt in.
- A takeover opens the live view in the phone's browser over Tailscale. If touch input does not work there, the takeover waits for the laptop within the 24-hour park, and a mobile live view becomes its own task.

Voice notes wait until a routine needs them. Then the options are a speech-to-text API (OpenAI or Groq Whisper, cents an hour, audio leaves the machine) or `whisper.cpp` on the machine (free, slower on a shared CPU). Start with the API.

### 7. A bot email address

Grok Bot gives each bot its own address, and an email can start a routine.

| Option                                                             | Pros                                                      | Cons                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| Cloudflare Email Routing to an Email Worker that posts to the host | Free, on a domain I own, and the Worker wakes the machine | Inbound only. Replies go through my Gmail integration      |
| Poll a Gmail label with the existing Gmail integration             | No new service                                            | A delay of minutes, and it needs the machine awake to poll |
| An inbound email service (Postmark, Mailgun)                       | Parsed attachments                                        | Another vendor and its cost                                |

**Pick:** Cloudflare Email Routing, after the gate. Email text is outside text, so its runs get the `untrusted` flag ([Decision 3](#3-approvals-in-unattended-runs)). The Email Worker must reach the host, which sits on my tailnet in Stage 1, so it posts through Tailscale Funnel or a public domain.

### Cost guards and usage

- Every run row stores its token counts, `total_cost_usd` and the time it spent parked, beside `started_at` and `finished_at`. This shipped in `c23db66`. Stage 3's awake hours and model cost come from this same table, with no second meter.
- Each run has a wall-clock cap, 30 minutes not counting parked time. Past it, the run fails.
- A routine pauses after 5 failed runs in a row (agentes.chat) and tells me.
- A host setting, `pauseAfterAbsenceDays`, pauses every routine when I have done nothing in the web UI or a channel for that many days, with a warning 2 days before. My host uses 14, and 0 turns it off. The product's default is a Stage 3 decision, because a business owner may want routines that run untouched.
- No dollar budget in Stage 1. On a Claude plan, `total_cost_usd` is an estimate at API prices, not money spent. Budgets come with API keys in Stage 3.

## Company brain decisions

### B1. Where the brain lives

| Option                                                                                                                          | Copy from         | Pros                                                                                                                             | Cons                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A `brain/` folder of Markdown files in the data root, one page per topic, with front matter for `source`, `updated` and `owner` | Turnstone's Brain | Readable and editable by people, works in Obsidian, diffs cleanly, survives a change of harness, and the backup is a folder copy | Nothing enforces structure, and search needs an index             |
| Tables in SQLite (entities, facts, relations)                                                                                   | None              | Structured queries                                                                                                               | Opaque to the owner, and every view needs UI work                 |
| Notion or Google Drive as the source of truth                                                                                   | Grok Bot's advice | Owners already keep documents there                                                                                              | Messy structure, write-back is hard, and it depends on connectors |
| A memory service (Zep, mem0 or a knowledge graph)                                                                               | None              | Extracts facts on its own                                                                                                        | Another service, opaque, and hard to correct                      |

**Pick:** the Markdown folder. Notion and Drive feed it through routines ([B4](#b4-filling-the-brain)). Today's `memory.md` becomes `brain/me.md`, and each bot's own memory stays where it is.

### B2. How bots find things

| Option                                                                                          | Pros                                       | Cons                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Load the whole brain into every prompt (how `memory.md` works today)                            | No code                                    | Breaks past a few thousand lines, and costs tokens on every turn |
| A short index page in the prompt, plus `brain_search` (SQLite FTS5) and `brain_read` host tools | Cheap, predictable, and no embedding model | Misses vague questions phrased in other words                    |
| Add embeddings (`sqlite-vec`) for hybrid search                                                 | Better recall                              | An embedding model, its cost and its provider                    |
| Let the bot `grep` the folder from its shell                                                    | No code                                    | Harness-specific, and no access control                          |

**Pick:** the index plus FTS5 tools, served from the host's MCP endpoint like the browser tools (ADR 0001). Add embeddings only when real questions show FTS5 missing answers.

### B3. Who may change the brain

| Option                                                                                                                        | Copy from                                                      | Pros                  | Cons                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| Bots write directly (`remember` today)                                                                                        | Grok Bot personal bots                                         | No friction           | One wrong fact or injected page poisons every bot |
| Every change is a proposal I approve as a Needs-you card with the diff                                                        | Grok Bot Team Bots, where the owner approves what a bot learns | Safe                  | Friction                                          |
| Tiers: a bot writes its own notes freely, and company pages need approval. Facts from web pages or email always need approval | None                                                           | Safe where it matters | More rules to explain                             |

**Pick:** tiers. Every approved change is a commit in a git repository inside `brain/`, so any change can be undone.

### B4. Filling the brain

| Option                                                                                        | Pros                                                   | Cons                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| An interview bot that asks the owner about the company, offer, customers, voice and processes | Fits a business owner on day one, and is the best demo | Only as good as the questions            |
| Upload files (PDF, documents, price lists) and convert them to pages                          | Uses what exists                                       | Conversion quality varies                |
| A nightly librarian routine that reads Drive, Notion and Gmail and proposes updates           | Keeps the brain current                                | Token cost, and many proposals to review |
| Import from another assistant (Grok Bot's import prompt)                                      | Moves a user's history in                              | Personal facts, not company facts        |

**Pick:** the interview first, uploads second, the librarian routine third. The import prompt comes in Stage 2.

### B5. Trust and access

| Option                                                    | Pros                                    | Cons                                                           |
| --------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Every bot reads every page                                | Simple                                  | A bot that reads email from strangers can repeat finance pages |
| Read access per folder, granted per bot like vault grants | Reuses the grant pattern                | A grant screen to build                                        |
| Pages carry a `source`, and bots cite the page they used  | The owner sees why a bot said something | Bots must be told to cite                                      |
| A weekly routine lists pages not updated in 90 days       | Stale prices get fixed                  | One more routine                                               |

**Pick:** all of the last three. Access per folder matters to business owners and blocks the easiest prompt-injection path.

### 8. License

| Option                                      | Copy from           | Pros                                                                                 | Cons                                          |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Apache-2.0                                  | Rakazo, MausBot     | The best for a portfolio and the widest reach                                        | Anyone can host a competing copy              |
| Fair source (FSL), Apache-2.0 after 2 years | Sentry              | Readable and self-hostable, and nobody competes with your hosted version for 2 years | Not open source by the OSI definition         |
| AGPL-3.0                                    | agentes.chat, Rerun | A host of a changed copy must publish their changes                                  | Some companies ban AGPL                       |
| PolyForm Noncommercial                      | OpenBot             | Blocks commercial use                                                                | Blocks most business owners from self-hosting |
| Closed source                               | Reason, Turnstone   | Nobody copies it                                                                     | Shows employers nothing                       |

**Pick:** FSL. It serves both aims: employers and partners read all the code, and the hosted product keeps a two-year lead.

## Stage 3 decisions

### 9. Model access and terms

| Option                                                       | Copy from                      | Pros                                                                                                | Cons                                                  |
| ------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The customer signs in to the Claude CLI on their own machine | MausBot, OpenBot               | Uses their plan. The legal page allows "a platform hosts Claude Code" when the binary is unmodified | Plan limits apply, and Anthropic can change its terms |
| The customer brings an API key                               | All of them                    | Clearly allowed, and Max includes $100 of API credit a month                                        | Usage-based cost scares some owners                   |
| We resell tokens with a markup                               | Rakazo credits, Grok Bot usage | One bill and a margin                                                                               | Fraud and spend risk                                  |

**Pick:** CLI sign-in and API keys. Write `docs/provider-terms.md` and get a written answer from Anthropic before launch. If the answer is "no", the hosted product takes API keys only.

### 10. Control plane

| Option                                     | Copy from        | Pros                                                                          | Cons                           |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| Cloudflare Workers, D1 and Durable Objects | OpenBot, MausBot | Grows from the wake Worker, almost free, alarms per customer, EU jurisdiction | D1 caps each database at 10 GB |
| A Hono server with Postgres on one VM      | Rakazo           | Ordinary code                                                                 | A 24/7 server to run           |

**Pick:** Cloudflare. The wake Worker's cron becomes one Durable Object alarm per customer.

### 11. Each customer's machine

The Fly Machine from [Decision 1](#1-where-the-host-runs), one per customer. The comparison there holds, with two changes at scale. boat's start limits (200 a day on the $20 plan, 2,400 on the $2000 plan) cap the fleet, and the per-customer volume cost ($1.50) matters less than at one user. Hetzner stays the fallback if Fly's prices rise.

### 12. Backups

A nightly `VACUUM INTO` copy and a tar of the data root to an EU R2 bucket, kept for 30 days, plus one before every deploy. The `brain/` git history travels with it.

### 13. Each customer's secrets key

| Option                                                                       | Pros                                   | Cons                                  |
| ---------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------- |
| A Fly secret per customer, written to tmpfs at boot                          | No new code                            | We can read it from the Fly dashboard |
| AWS KMS envelope encryption: a data key per customer, wrapped by one KMS key | An audit trail, and keys we can revoke | A second cloud                        |
| A master key in a Worker secret, with HKDF per customer                      | Free                                   | One leak exposes every customer       |

**Pick:** the Fly secret for design partners, KMS at launch. The privacy policy says that we can decrypt, because unattended runs need it.

### 14. Accounts

**Pick:** better-auth in the Worker with D1. It is free, supports passkeys and keeps the data with us. WorkOS AuthKit is the alternative if teams arrive and need SSO. After sign-in the control plane issues a pairing for the customer's host, so device auth (ADR 0005) does not change.

### 15. Billing

| Option                                       | Fees                           | Pros                                                          | Cons                                                         |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Stripe Managed Payments (merchant of record) | Stripe fees plus 3.5%          | Stripe files sales tax in 80+ countries, and Poland qualifies | Checkout and Payment Links only, statements read `LINK.COM*` |
| Plain Stripe Billing                         | About 0.7% plus card fees      | The cheapest                                                  | We file EU VAT and any US sales tax ourselves                |
| Polar.sh (merchant of record)                | 3.6% to 5% plus 35 to 50 cents | Built for small software sellers                              | A small company                                              |

**Pick:** Stripe Managed Payments with flat plans. The control plane stops a machine at its plan's hours.

### 16. Pricing

| Option                                                                           | Copy from                  | Pros                                                      | Cons                    |
| -------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------- | ----------------------- |
| Awake hours: $15 for 100, $49 for 300, $99 for 800, model bought by the customer | MausBot                    | A proven ladder, and cheap to serve on a sleeping machine | "Hours" need explaining |
| A flat price with included model usage                                           | Grok Bot ($30, $100, $200) | One bill                                                  | We carry the model cost |

**Pick:** the hours ladder, with the brain's size and its connected sources as the difference between tiers.

## Rejected competitor choices

- Rakazo stores claude.ai OAuth tokens on its server. Anthropic's legal page forbids it.
- Rerun copies vendors' OAuth client IDs.
- Grok Bot's bots share one computer, so their sign-ins and files are not isolated per bot.
- MausBot and OpenBot default to full access with no approvals.
- Rerun skips missed runs silently. Nuphos reports missed runs and never runs them.
- Rerun, OpenBot and MausBot keep some secrets in plaintext.
- boat users who stop a machine without closing SQLite first corrupt it.

## Open questions

1. Which business owners can test the brain interview in Stage 3?
2. Do the first customers need EU-only data? If they do, Fly runs in `fra` or `ams`, R2 and D1 use the EU jurisdiction, and Cloudflare snapshots are ruled out.

## Sources

- Grok Bot: [overview](https://docs.x.ai/grok-bot/overview), [bots and memory](https://docs.x.ai/grok-bot/bots), [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [1.0 launch](https://x.ai/news/grok-bot-1-0), [product and pricing](https://x.ai/bot).
- Competitors: private research notes, not in the repository.
- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
- Fly.io: [pricing update](https://fly.io/pricing-update/), [pricing](https://docs.fly.io/about/pricing), [autostop and autostart](https://docs.fly.io/reference/fly-proxy-autostop-autostart.md), [suspend and resume](https://docs.fly.io/reference/suspend-resume).
- boat.dev: [pricing](https://docs.boat.dev/pricing.md), [terms](https://boat.dev/terms), [auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop.md), [OpenBot hosted servers](https://github.com/nightly-labs/openbot/blob/main/docs/hosted-servers.md).
- Cloudflare: [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Hetzner: [cost-optimized cloud](https://www.hetzner.com/cloud/cost-optimized).
- Billing and auth: [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments/how-it-works), [Polar fees](https://polar.sh/docs/merchant-of-record/fees), [better-auth passkeys](https://better-auth.com/docs/plugins/passkey), [AWS KMS pricing](https://aws.amazon.com/kms/pricing/).
- Phone: [Telegram bot features](https://core.telegram.org/bots/features), [Web Push on iOS](https://webkit.org/blog/12945/meet-web-push/).
