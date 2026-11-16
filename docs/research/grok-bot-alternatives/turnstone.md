# Turnstone (myturnstone.ai) research (2026-11-13)

## 1. What it is

- Closed-source **macOS desktop app** for running a "team of AI Agents"; each Agent has its own job, model and memory, and they share one memory called the "Brain" (https://myturnstone.ai/facts, "Last reviewed November 9, 2026"). Calls itself "a free, model-agnostic Grok Bot alternative that runs on the AI subscriptions you already have".
- Maker: **Crow Inc.**, San Francisco, founders Aryan Vij and Jai Bhatia, **Y Combinator W26**; also lists Pioneer Fund, Robinhood Ventures, UpScaleX, OpenAI, Microsoft as backers (/facts, homepage). Product Hunt "#2 Product of the Day" badge (homepage).
- **No public GitHub repo found** (web search for "Turnstone myturnstone.ai github open source" turned up only site/docs/LinkedIn pages; `gh search repos myturnstone` found nothing). Terms grant "a limited, nonexclusive right to use Turnstone… Separate open-source components retain their own licenses" (https://myturnstone.ai/terms), so it is a **proprietary** product. Not open source despite the comparison group's framing. Version line: changelog runs 0.1.4 → 0.8.7 (https://myturnstone.ai/sitemap.xml).

## 2. Infra / self-hosting / laptop-off behavior

- **Runs on the user's Mac** (Apple silicon and Intel). Platform status: Mac app available now; Turnstone Cloud, iPhone app and web app "Coming soon"; Windows/Linux/Android "Not available" (/facts). Positioned as "Not a coding tool or developer framework. No terminal or server needed" (/facts).
- **No self-host server story.** Nothing to self-host; the comparison page sells it as "For people who don't want to run a server" (https://myturnstone.ai/comparisons/openclaw).
- **Laptop off = agents stop.** The docs say: "Automations use Turnstone's in-app scheduler, not cron or Windows Task Scheduler. They run only while Turnstone is alive" (https://docs.myturnstone.ai/concepts/automations). The homepage demo has the agent say a brief "comes at 8:00 AM on weekdays when your Mac is on".
- **Turnstone Cloud** (coming soon; the privacy page calls it a "limited-access beta") "keeps them working while your Mac is closed, and you can message them from your phone" (homepage). Privacy page: "Cloud Agents and Cloud Routines process prompts and relevant context on hosted infrastructure… Cloud computers can retain files and browser sessions"; "Cloud infrastructure can include E2B"; "Archives and Cloud provider credentials use server-controlled encryption. Turnstone's service can decrypt them" (https://myturnstone.ai/privacy). [INFERENCE] Cloud execution probably runs in E2B sandboxes.
- **Data:** "Your Agents, chats and memory are kept on your Mac, in a folder you can open" (homepage). The Brain is "stored as plain files on your Mac that you can open and correct" (/facts; https://docs.myturnstone.ai/concepts/brain). Browser site data stays on the device and is "not included in Turnstone's cloud account sync" (https://docs.myturnstone.ai/concepts/browser), which means some account sync does exist. Backend providers: "Supabase and AWS" for hosting/storage/auth, plus Resend, Stripe, Composio, PostHog and Google Analytics (privacy).
- **Isolation:** permission modes are "Read only, Ask first, and Always Allow" (https://docs.myturnstone.ai/controls/permissions). Automations and Skills changes show review cards before they apply. Coding Mode is opt-in per Agent (docs/controls/coding-mode). Each Agent gets its own browser tab and profile. No local code-execution sandbox is documented [UNVERIFIED].

## 3. Claude / Codex subscription use

- **Yes, both, through the official CLIs' own logins**: "ChatGPT: Your own ChatGPT plan, through the official Codex app and OpenAI's own login"; "Claude: Your own Claude plan, through the official Claude Code app and Anthropic's own login" (/facts). [INFERENCE] It wraps the locally installed Codex CLI / Claude Code (or their SDKs) instead of using Turnstone-held OAuth tokens. The exact mechanism (setup-token, Agent SDK) is not documented [UNVERIFIED].
- Other providers: Gemini account, Grok account, **Cursor account**, Ollama (local models), OpenAI or Anthropic API key, and "Turnstone Credits" (prepaid, Turnstone-managed models) (/facts). You can switch models mid-conversation and the Agent keeps its context (homepage; changelog 0.1.7 "Cross-model handoffs").
- ToS/ban risk: none documented. The site only says "Usage counts against your own plan's limits" (/facts).

## 4. MCPs / apps / integrations

- **MCP server:** "Another AI, like Grok Bot, ChatGPT or Claude, can connect to Turnstone's MCP server to create Agents and send them work". This is the migration path for Grok Bots, alongside importing a Grok Bot from its x.ai marketplace link and "Freebot", a helper bot that runs inside Grok Bot (/facts, homepage).
- **MCP client:** the changelog mentions connecting "Firecrawl through OAuth MCP" and "Resend through its official OAuth MCP server", plus "connectors you add" (changelog; /facts).
- **Apps:** "60+ apps built in", e.g. Gmail, Outlook, Google Calendar, Drive, Slack, Notion, Linear, HubSpot, LinkedIn, Granola, Dropbox, Zoom, iMessage and WhatsApp (/facts; https://docs.myturnstone.ai/concepts/connected-apps). Also the apps on your Mac and any website through the built-in Turnstone Browser, which can import a Chrome or Arc profile (docs/browser).
- **How Gmail works:** you sign in from Turnstone's app list. "You won't need a Google Cloud OAuth client" (comparison pages). The privacy page lists **Composio** as a provider, and the changelog mentions "Composio Connect with OAuth". [INFERENCE] Gmail and similar OAuth goes through Turnstone's or Composio's OAuth apps. 1Password connects through its official CLI (changelog). The Brain syncs on a schedule (e.g. "Every 3 hours") from Gmail, Calendar, Slack, Granola and iMessage (homepage).
- **iMessage** reads and sends from your own Messages app and number. WhatsApp is listed as "Reads WhatsApp" (comparison pages).
- **Chat channels:** none in the bot sense. "You talk to Turnstone in its own Mac app… Your Agents work with iMessage and WhatsApp as two of 60+ apps, rather than living inside them as a bot" (comparisons/hermes-agent FAQ). **No Telegram or Discord bot.** iPhone and web apps are coming soon.
- **Skills:** "Featured by Turnstone" plus "Your Skills". Agents can propose a Skill, and you save it after a review card (https://docs.myturnstone.ai/concepts/skills). Agents can also hand tasks to each other ("Chief of Staff" orchestrator).

## 5. Monetization

- **Mac app: "$0 forever"**, with "Persistent Agents, your Chief of Staff and free connectors to your apps. No card needed" (homepage, seen 2026-11-13).
- **Turnstone Credits** (optional): prepaid model usage "at provider prices". Top-ups start at **$10, $11.18 total including the processing fee** (/facts; https://myturnstone.ai/plan). An "$8" figure also appears on /plan, context not parsed [UNVERIFIED]. "The old Turnstone AI plans are no longer sold" (/facts).
- **Turnstone Cloud: $49/month** after a free first month for the first 1,000 people (counter showed "637 free months left") (homepage).
- No open-core or license tiers. The product is proprietary, VC-funded (YC).

## 6. Differentiator

- The only one in the group that is a **polished consumer native Mac app** for non-coders, with nothing to host. Most peers are OSS self-host or server agents [INFERENCE about peers].
- It uses **Claude and ChatGPT plans through the official Claude Code and Codex apps**, plus Cursor, Grok and Gemini accounts, and lets you **switch models mid-conversation** while keeping context.
- **Shared "Brain"**: plain local files built from scheduled syncs of Gmail, Slack, Calendar, iMessage and Granola, and it learns your writing style for each account.
- **Grok Bot migration tooling**: an MCP server that bots can call to recreate themselves, x.ai link import and the Freebot helper.
- Native iMessage send from your own number and a per-Agent browser.
- **Weaknesses:**
  - It is **not open source**.
  - It is **Mac-only**.
  - **Nothing runs while the Mac is off** until Cloud ships (Cloud is a limited beta at $49/mo).
  - There are **no Telegram, Slack or WhatsApp bot channels** to message it from your phone.
  - Cloud credentials use server-side decryptable encryption.
  - The product is young (changelog runs 0.1.4 → 0.8.7 per https://myturnstone.ai/sitemap.xml; YC W26).

## 7. Tech stack

- No source available, so the stack is mostly unverified.
- **Known from the site:** native macOS app; Supabase and AWS backend (auth/storage); Stripe for payments; Composio for integrations; Resend for email; E2B for Cloud sandboxes; PostHog and GA analytics (privacy). The website is Next.js on Vercel (`/_next/image`, `dpl_` deployment IDs in the homepage HTML) [INFERENCE]. Docs are on Mintlify (docs.myturnstone.ai).
- **Unknown:** the desktop shell (Electron, Tauri or Swift) [UNVERIFIED; DMG not inspected]. The docs mention Windows Task Scheduler and Windows profile import, which hints at a cross-platform shell [INFERENCE].
- Model runtime: the official Claude Code and Codex apps, provider APIs, and Ollama locally.

## A. Agent browser

- **Tech:** an **embedded browser inside the Turnstone desktop app** ("Let an Agent work through Turnstone's embedded browser without switching apps", changelog 0.3.0–0.3.2). The underlying engine and automation layer (Electron webview/CDP, WKWebView, Playwright and so on) are not disclosed [UNVERIFIED]. I didn't inspect the binary because the download is behind `/invite`. No Browserbase, Steel or other cloud-browser vendor appears in the privacy provider list (https://myturnstone.ai/privacy).
- **Headed, on the user's Mac, visible.** Every Agent works "in its own tab of the Turnstone Browser… while you watch" (homepage). Agent tabs live in the Agent's right drawer, and from 0.3.2 "Agent-driven browser tabs no longer steal focus". The user can browse the same pane. Agent access to a tab uses "a separate access flow and an Agent-owned Browser tab", so a tab the user is viewing is not automatically shared (https://docs.myturnstone.ai/concepts/browser). There is no explicit "take over" control documented [UNVERIFIED]. No Xvfb or VNC: it is a native GUI.
- **Profiles:** a local Turnstone profile per Turnstone account, not per Agent. Tabs belong to an Agent but last only for the app session. Sign-ins persist in "that Turnstone account's local Browser profile" (docs/browser), with multiple profiles switchable (changelog 0.7.2–0.7.4). On macOS you can **import a one-time copy of a Chrome or Arc profile**, which "may not preserve every login" (docs/browser; changelog 0.1.8 "browser profiles"). So it reuses the user's logins by copying them, not by driving the user's real Chrome.
- **Constraints:** HTTPS and localhost only; insecure public HTTP is blocked (docs/browser). Agents can upload authorized local files through Browser upload controls (changelog 0.7.10–0.8.0).
- **Cloud:** "Cloud computers can retain files and browser sessions", and recovery archives can include "browser cookies or site storage" (privacy). [INFERENCE] Cloud browsing runs in hosted VMs, possibly E2B.
- **Anti-bot, captcha or stealth measures:** none documented [UNVERIFIED].
- **Built-in tool, not an MCP.**

## B. Credentials and secrets

- **No source code is available**, so none of this can be checked against code; everything below comes from the docs and privacy page.
- **Local:** chats, memory and the Brain are plain files in a folder on the Mac (homepage; /facts). Browser site data stays on the device and is "not included in Turnstone's cloud account sync" (docs/browser). The storage for local API keys and tokens (macOS Keychain or otherwise) is **not documented** [UNVERIFIED].
- **Claude and ChatGPT subscriptions** go through "the official Claude Code app and Anthropic's own login" and "the official Codex app and OpenAI's own login" (/facts). [INFERENCE] The tokens stay in those CLIs' own stores (e.g. `~/.codex/auth.json`, Claude Code credentials) and Turnstone launches them locally. This is supported by "Turnstone retries a stalled Codex startup" (changelog 0.5.15) and "Connect native Codex and Claude Code chats" (0.7.3).
- **App OAuth (Gmail, Slack and others):** sign in from Turnstone's app list, with no user-supplied Google OAuth client (comparison pages). Composio is a listed provider, and "Composio Connect with OAuth" is an option (privacy; changelog 0.8.7). [INFERENCE] Those OAuth tokens are held by Turnstone and/or Composio servers, not on the Mac. iMessage is read locally "without sending it through a third-party connector" (changelog 0.5.0). 1Password connects through its official CLI (0.8.7).
- **Vendor-held secrets:** "Archives and Cloud provider credentials use server-controlled encryption. Turnstone's service can decrypt them to operate or recover the feature". Recovery archives can contain workspace files and browser cookies. "Disabling Cloud does not automatically delete existing hosted records" (privacy). Phone remote control uses "encrypted relay messages", with routing and pairing metadata stored (privacy; changelog 0.5.2–0.5.8). The production Supabase project is in the US (privacy).
- **Exposure to the LLM, proxy injection, sandbox env tokens:** not documented [UNVERIFIED].
- **Controls that are documented:**
  - Permission modes: Read only, Ask first, Always Allow. With Always Allow, "sensitive connected-app actions may still require review" (https://docs.myturnstone.ai/controls/permissions).
  - In-chat approval cards for sensitive actions (changelog 0.3.1–0.3.3), Slack changes (0.3.6), batched Gmail changes (0.5.28) and phone calls (0.5.15/0.5.17).
  - Review cards before Schedules, Skills or Brain changes apply.
  - Connecting an account "does not give every Agent unlimited access"; apps are selected per chat or turn (docs/connected-apps).
  - "Safe or isolated work may intentionally omit Brain access" (docs/brain).
  - Outbound messages wait for the user to send them ("Nothing goes out until you send it", homepage). Agents also have their own email address at agent.myturnstone.ai (0.5.28).
- **Not documented:** prompt-injection defences and a user-facing audit log [UNVERIFIED]. The vendor does collect "model usage, token counts, costs and run outcomes" (privacy).

## C. Crons / scheduling

- **Mechanism:** an in-app scheduler: "Automations use Turnstone's in-app scheduler, not cron or Windows Task Scheduler. They run only while Turnstone is alive" (docs/automations). No launchd agent. The scheduler library is unknown [UNVERIFIED].
- **Naming has changed:** "Automations", then "Schedules" (0.5.28; reminders merged in), then "**Routines**" (0.8.2/0.8.6).
- **Creating schedules:** in natural language ("every weekday at 9"; homepage) or from the Agent's drawer panel. **Agents can create, change, pause, resume or delete schedules**, but always through a review card ("The Agent cannot silently create or alter the schedule", docs/automations).
- **Each run:**
  - Runs in the owning Agent with "clean execution context". The result goes to a labeled Side Chat and the Inbox (docs; 0.5.30; 0.7.0).
  - Each Schedule shows its "timing, task, destinations, and safety limit" (0.5.28). [INFERENCE] The safety limit is a per-run cost or step cap.
  - Run history is viewable and editable ("Open past Schedule runs", 0.5.32).
  - Recovery: "Scheduled work can recover when a connection breaks or a service limit is reached" (0.5.35). Local scheduled work "inherits its Agent's AI, with recovery for eligible connected subscriptions" (0.7.9).
- **Not documented:** missed-run catch-up when the Mac was asleep or off, timezone handling, and concurrency limits [UNVERIFIED].
- **Other triggers:**
  - Brain sync from connected apps on a user-chosen interval, e.g. "Every 3 hours" (homepage).
  - Inbound mail to the Agent's own email address (0.5.28; Inbox).
  - Phone Dispatch messages and Jarvis voice from the iPhone (0.5.22–0.8.0).
  - The MCP server, which lets other AIs send work (/facts).
  - "webhook features" are mentioned in privacy, details unknown [UNVERIFIED].
- **Laptop-off topology:** none locally. "Turnstone Cloud will keep your Agents and their Schedules working with your Mac closed" (comparisons/openclaw), and the Early Access plan bundled "Schedules, cloud execution" (0.6.5–0.7.1). Cloud is a limited beta.

## D. Stack scope clarification

- **(1) Self-hosted or open-source build:** **does not exist.** The product is proprietary (terms) and no repo was found, so nothing was verified from source.
- **(2) Vendor build:** a closed macOS app plus a closed backend.
  - Verified from the privacy page: Supabase (US production project) and AWS for hosting, storage and auth; Composio for app connectors; E2B as possible Cloud infrastructure ("can include E2B"); Resend; Stripe; PostHog and GA.
  - Verified via cheap header/DNS checks: the marketing site is served by **Vercel** (`server: Vercel`, `x-vercel-id` response headers). docs.myturnstone.ai is a CNAME to `cname.mintlify.builders`.
  - The web app (0.7.0, pairs to a Mac by code) and phone relay are hosted, location undisclosed [UNVERIFIED].
- **Same code question:** not applicable, since there is no public code. How Turnstone Cloud is deployed beyond "Supabase and AWS… can include E2B" is not published.
- **Desktop shell:** unknown (Electron, Tauri or Swift) [UNVERIFIED]. The docs mention Windows Task Scheduler and Windows profile import, which hints at a cross-platform shell [INFERENCE].
- **Supported surfaces:** an OpenAI-compatible custom inference endpoint is supported (0.8.6), and Claude Code and Codex chats can be imported (0.3.0, 0.7.3).
- **Sources added:** https://myturnstone.ai/sitemap.xml and all changelog pages listed there (0.1.4–0.8.7); https://docs.myturnstone.ai/controls/permissions; `curl -I https://myturnstone.ai/`; `dig docs.myturnstone.ai`.

## Sources

- https://myturnstone.ai/ (homepage, pricing teaser, Cloud $49)
- https://myturnstone.ai/facts (reviewed 2026-11-09)
- https://myturnstone.ai/plan
- https://myturnstone.ai/comparisons/openclaw, /comparisons/hermes-agent, /comparisons/grok-bot
- https://myturnstone.ai/changelog, /changelog/0.5.28, /changelog/0.1.7
- https://myturnstone.ai/privacy, https://myturnstone.ai/terms
- https://docs.myturnstone.ai/llms.txt and concepts/{connected-apps,automations,browser,skills,brain}, controls/{permissions,coding-mode}
- https://linkedin.com/company/turnstone-ai ("Turnstone (YC W26)")

## Deep-dive: browser, secrets, crons (2026-11-13)

Turnstone is closed source and there is no repo, so everything below comes from the docs (docs.myturnstone.ai, llms-full.txt), the changelog JSON on myturnstone.ai/changelog and /privacy. I did not inspect the app binary. Implementation details are therefore marked [UNVERIFIED] or [INFERENCE].

### 1. Agent browser

- **Engine:** the "Turnstone Browser" is **embedded in the Mac app**. Docs call it a "human-controlled web browser in the current Agent's right drawer" (docs concepts/browser). The changelog lists "Built-in browser automation: Let an Agent work through Turnstone's embedded browser without switching apps". The engine is not named: WebKit WKWebView, an Electron webview or CDP-driven Chromium [UNVERIFIED]. It is not Browserbase, Steel or Browser Use; no such provider appears in the privacy provider list (privacy "Who receives information").
- **Headed, on your Mac.** Agent tabs are visible in the drawer, so you can watch them live. Changelog: "Agent-driven browser tabs no longer steal focus from the work in front of you" ("Background browser stability"). You take over by using the same tab in the drawer. There is no VNC; none is needed because it runs locally.
- **Separate Agent access:** "Viewing or signing into a website does not automatically grant the Agent access to your tab. When an Agent needs to interact with a website, Turnstone uses a separate access flow and an Agent-owned Browser tab. Current permissions remain authoritative" (docs/browser). Browser actions are therefore gated by the Read only / Ask first / Always Allow modes (docs controls/permissions).
- **Profiles and logins:**
  - Each Turnstone account gets a local profile: "Website sign-ins and other site data stay in that Turnstone account's local Browser profile".
  - Tabs belong to one Agent and last for the app session (docs/browser).
  - Changelog adds "Persistent browser profiles… signed-in browser profiles, navigation history, and identity" and "Browser profile switching".
  - Logins are **manual sign-in inside the embedded browser**, or a **one-time snapshot import of a Chrome or Arc profile** (macOS only). The import "may not preserve every login"; it copies the profile and does not drive your live Chrome.
  - Site data is "not included in Turnstone's cloud account sync" (docs/browser).
  - No credential injection that hides passwords from the model is documented. 1Password is connected "through its official CLI" as a connected app (changelog), which [INFERENCE] could let the agent fetch secrets.
- **Uploads:** "Agents can attach authorized local files through Browser upload controls" (changelog).
- **Model tool surface:** not documented, whether snapshot/accessibility tree or screenshots [UNVERIFIED].
- **Network policy:** only HTTPS and loopback addresses are allowed; "Insecure public HTTP pages are blocked" (docs/browser). No domain allow/deny list, stealth, captcha handling or prompt-injection defense is documented beyond the permission gating [UNVERIFIED].
- **Cloud (beta):** "Cloud computers can retain files and browser sessions"; Cloud infrastructure "can include E2B". "Recovery archives can contain… supported browser cookies or site storage" (privacy). [INFERENCE] Cloud runs use a browser inside an E2B sandbox VM.

### 2. Credentials / secrets

- **Model subscriptions:** Claude and ChatGPT work "through the official Claude Code app / Codex app and Anthropic's/OpenAI's own login" (/facts). The tokens therefore live where those CLIs keep them (e.g. Claude Code uses the macOS Keychain) and Turnstone does not hold them [INFERENCE].
- **API keys:** OpenAI and Anthropic keys and custom OpenAI-compatible endpoints are supported (changelog 0.8.2). Local storage (Keychain or file) is not documented [UNVERIFIED].
- **Connected-app tokens:** "Requests may pass through our backend and services such as Composio, or use direct integrations. Some connection credentials are stored encrypted on our servers or by connection providers" (privacy). OAuth for Gmail and similar apps uses Turnstone's or Composio's OAuth clients ("no Google Cloud OAuth client" needed; comparison pages). The vendor and Composio can therefore act with your tokens. The algorithm and KMS are not disclosed.
- **Cloud:** "Archives and Cloud provider credentials use server-controlled encryption. Turnstone's service can decrypt them" (privacy). This is not end-to-end encryption. The phone relay is the exception: "Phone remote control uses encrypted relay messages; we store encrypted content and routing/pairing metadata". The privacy page adds that "Relay encryption does not cover every other Turnstone feature".
- **Exposure to the LLM:** no secret brokering or placeholder/egress proxy is documented. Integrations are tool calls, so the model sees results, not tokens [INFERENCE].
- **Approval gates:**
  - Permission modes apply to agent actions; even under Always Allow, "sensitive connected-app actions may still require review" (docs/permissions).
  - Sends are review-gated: "Review and send new Outlook messages" and "take reviewed actions on Reddit" (changelog).
  - Schedules carry a "safety limit" (changelog 0.5.28).
- **Redaction and telemetry:**
  - Bug reports "can include logs and current-chat context… We filter recognized credentials and common secret formats, but the filters do not remove all" (privacy).
  - Usage telemetry (model usage, token counts, costs, run outcomes) is account-linked and "excludes conversation text and connected-app payloads" (privacy).
  - PostHog session replay applies to the website (privacy).
- **Per-agent scoping:** apps can be connected per Agent ("Connect the apps that fit each Agent's job", changelog). No teams or team-member access model and no audit log are documented. Local data is "in a folder you can open" and the Brain is plain files (homepage, /facts), so local data is [INFERENCE] readable by any process running as your macOS user.
- **Weaknesses:**
  - Cloud and connector credentials can be decrypted server-side.
  - The local storage format for API keys is undisclosed.
  - No self-host option exists, so the vendor sits in the OAuth path.

### 3. Crons / scheduling & triggers

- **Scheduler:**
  - Docs: "Automations use Turnstone's **in-app scheduler, not cron or Windows Task Scheduler**. They run only while Turnstone is alive" (docs concepts/automations). [INFERENCE] It is an in-process timer, with no launchd job.
  - The feature has been renamed twice: Automations, then Schedules (0.5.28, "Automations and reminders now live together as Schedules"), then **Routines** (0.8.2).
- **Creation:** in the Agent's right drawer (UI) or by asking the Agent. "When an Agent proposes an Automation change, Turnstone shows a review card before applying it. The Agent cannot silently create or alter the schedule" (docs/automations). There are one-off **Reminders** ("Ask an Agent to schedule future work", changelog) and recurring Schedules. Timing is set in natural language or the UI, e.g. "8:00 AM on weekdays" and "Every 3 hours" Brain sync (homepage). No cron-expression or timezone syntax is documented [UNVERIFIED].
- **What a run is:**
  - "Each run starts with clean execution context, and its result returns in a labeled Side Chat under the owning Agent" (docs/automations).
  - "Every Schedule runs in the Agent that created it, with its own side chat and context" (changelog). The Agent's memory and Brain are available [INFERENCE].
  - Local scheduled work "inherits its Agent's AI, with recovery for eligible connected subscriptions" (changelog).
- **Reliability:**
  - "Resilient Schedules: Scheduled work can recover when a connection breaks or a service limit is reached" (0.5.35).
  - Runs "queued behind active work recover instead of getting stuck" (changelog). This implies queueing behind the active run, not overlap [INFERENCE].
  - Missed-run catch-up while the app is closed is not documented [UNVERIFIED].
- **History and notifications:**
  - "Schedule history: Open past Schedule runs" (0.5.32).
  - Results and delivery status go to the Agent chat and a unified **Inbox**, optionally "receive its results by email" (Agent-owned Automations).
  - Each Schedule shows "timing, task, destinations, and safety limit" (0.5.28). The safety limit is per-run [INFERENCE: a cap on actions or spend]. Approvals go through "Clearer approvals" cards. What happens to an approval while you are away is not documented ([INFERENCE] it waits in the Inbox).
- **Other triggers:**
  - **Agent email inboxes** via Resend ("Agent Mail in Inbox", privacy "Agent inboxes use Resend"). Whether inbound mail auto-triggers a run is [UNVERIFIED].
  - Scheduled Brain syncs from Gmail, Slack, Calendar, iMessage and Granola (polling).
  - An MCP server that lets external AIs send work.
  - No webhook, GitHub or file-watch triggers are documented.
- **Host off:** local Routines don't run. "Schedules work while your computer is closed (cloud handoff)" is part of the $49/mo Early Access/Cloud plan (changelog: "Agent creates a morning Gmail triage Schedule that runs in the cloud even when the Mac is off"). It stores "execution records, including outputs and checkpoints" server-side (privacy).

### Sources (deep-dive)

- https://docs.myturnstone.ai/concepts/browser.md, /concepts/automations.md, /controls/permissions.md, /llms-full.txt
- https://myturnstone.ai/changelog (versions 0.1.7, 0.1.8, 0.3.x, 0.5.28, 0.5.32, 0.5.35, 0.7.2, 0.8.1, 0.8.2)
- https://myturnstone.ai/privacy (connected apps, cloud features, bug reports, providers, security)
- https://myturnstone.ai/facts, https://myturnstone.ai/ (homepage)

## E. Sandbox / agent computer: what it is used for

### 1. What the "computer" is

- **Locally there is no container or VM: the user's own Mac is the computer.**
  - **Unit of access:** a **folder on the Mac** chosen as the workspace. "Read Only, Ask First, and Always Allow keep Turnstone confined to the selected folder… the workspace acts as a sandbox, so the rest of your computer stays off-limits" (https://myturnstone.ai/learn).
  - **Full Access:** "removes the sandbox entirely — Turnstone can read and act across your whole computer" (/learn).
  - The enforcement mechanism (macOS sandbox profile, the Codex or Claude Code CLI sandbox, or path checks) is not disclosed [UNVERIFIED].
- **Granularity:**
  - Each Agent has its own folder ("Work with files in an Agent's folder", https://myturnstone.ai/howto).
  - Each Agent has its own scratch folder separate from the Brain (docs/brain).
  - Each Agent gets its own browser tab.
  - The agent loop itself runs in the Mac app, and/or inside the local Codex or Claude Code processes [INFERENCE].
- **Lifecycle:** persistent. The folder holds real files: "Any changes Turnstone makes are applied to the actual files on your computer" (/learn).
- **Capabilities:**
  - Create, edit, rename, move and delete files (/learn).
  - Read PDFs, CSVs, images and office documents; edit Markdown (/learn).
  - Preview HTML in a side viewer (changelog 0.1.8, 0.7.4).
  - A Remotion-based Video Editor (0.7.5).
  - **Coding Mode** for software work, which must be opted into (docs/controls/coding-mode).
  - Use apps on the Mac and the embedded browser (/facts; section A).
  - Explicit shell, package installs and dev servers are not documented [UNVERIFIED]. The homepage demo shows an Engineer Agent changing code and running "all 212 tests", which implies it can run commands in Coding Mode [INFERENCE].
- **Cloud computer:** "Cloud computers can retain files and browser sessions"; "Cloud infrastructure can include E2B" (privacy). [INFERENCE] These are persistent hosted VMs or sandboxes for each account, used so that Agents and Schedules keep running with the Mac off. The spec is not published.

### 2. Use cases the project shows

| #   | Use case (source)                                                                                                                       | Needs a computer, or API/MCP only                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | "Read a PDF, analyze a spreadsheet, draft a report, or create a presentation" in the Agent's folder (/howto)                            | Local folder                                     |
| 2   | "Create a project brief from these meeting notes and save it in this folder" (/learn)                                                   | Local folder                                     |
| 3   | Budget or tracker spreadsheet created from one request and opened in-app; "six sample cost items and a total" (/howto)                  | Local folder                                     |
| 4   | Engineer Agent: find why invite links expire early, change one line, run tests, don't push, then offer to push and open a PR (homepage) | Local folder + Coding Mode (+ GitHub App, 0.5.8) |
| 5   | Outreach Agent fills the "Apply to Demo Night" form at demonight.co "while you watch" (homepage)                                        | Embedded browser                                 |
| 6   | Weekday 8:00 brief on meetings, what you owe people and urgent items (homepage)                                                         | Schedule + connected apps; no folder needed      |
| 7   | Draft 42 personalized beta invites for review in Gmail (homepage)                                                                       | API/connectors only                              |
| 8   | Signups-by-source table: 128 this week, split by LinkedIn, newsletter and referrals (homepage)                                          | Connectors; table preview (0.8.7)                |
| 9   | "Build, inspect, and deploy Lovable projects"; "Create and manage Conductor coding-agent workspaces" (changelog 0.5.20, 0.5.10)         | External services, not a local sandbox           |
| 10  | Video editing with Remotion (0.7.5)                                                                                                     | Local runtime [INFERENCE]                        |
| 11  | Place a reviewed phone call and report back (0.5.15/0.5.17)                                                                             | Telephone provider, no computer                  |

### 3. End-to-end flows

- **Flow 1: file work with a permission gate** (/learn, docs/permissions)
  1. The user picks a folder and sets the mode to Ask First, then asks "Create a project brief from these meeting notes and save it in this folder".
  2. The Agent reads the notes inside the folder and prepares the file.
  3. Protected actions pause on an approval card. The user approves.
  4. The file is written to the real folder, and the user opens it from the file explorer drawer or Editor Mode.
- **Flow 2: scheduled run, user absent** (homepage; docs/automations; /howto)
  1. The user says "Every weekday at 9, brief me on new signups and replies".
  2. The Agent proposes a Schedule, and the user approves the review card.
  3. At 9:00, if Turnstone is open and the Mac is awake ("Local Schedules run while Turnstone is open and your Mac is awake. Cloud Schedules can run while your Mac is offline", /howto), the run starts with clean context, reads the connected apps, and posts "Morning brief ran on schedule" to a Side Chat and the Inbox.
  4. Any outbound reply waits as a draft ("Nothing goes out until you send it").
- **Flow 3: coding with approval before push** (homepage demo) [INFERENCE for the exact mechanics]
  1. The user asks: "fix it, but don't push".
  2. A "Turn on coding" review card appears, and the user approves it (docs/coding-mode).
  3. The Agent edits the repo in the local folder and runs the tests.
  4. It reports the diff and asks "Want me to push it and open a pull request?". The push goes through the GitHub App after the user says yes.
- **Browser variant with the user watching:** the Agent opens an Agent-owned tab and fills the form while the user watches in the side drawer (homepage; docs/browser). An explicit takeover button is not documented [UNVERIFIED].

### 4. File and data flow

- **Files in:**
  - The selected local folder, used directly (no upload).
  - Drag files from the explorer into the chat.
  - Attach files and images to a message (/howto).
  - Agents can upload authorized local files through Browser forms (0.7.10–0.8.0).
- **Files out:**
  - The same folder.
  - "Library", formerly Files (0.8.2).
  - Downloadable artifacts in chat (e.g. `launch-email.md`, homepage).
  - HTML artifacts open in the Turnstone Browser (0.7.4).
  - The phone app can view photos and table previews (0.8.0, 0.8.7).
- **Access to local files:** the sandbox _is_ the local machine, so the selected folder is fully reachable, and Full Access reaches the whole computer.
- **Cloud:** Cloud setup "explains what moves" (0.8.7). Recovery archives can contain workspace files (privacy).
- **Egress:** the browser allows HTTPS and localhost only (docs/browser). No other network egress policy is documented [UNVERIFIED].

### 5. Limits and caveats

- Local runs need Turnstone open and the Mac awake. Cloud is a limited beta at $49/mo after a free first month (homepage). No per-hour compute pricing is published.
- Isolation is only as strong as a folder boundary on the user's real machine. Full Access is described by the vendor as "genuinely risky" (/learn). There is no VM isolation locally.
- Coding Mode is experimental-ish: there is a device-wide override in Settings → Experimental (docs/coding-mode). Shell, package-install and dev-server capabilities are undocumented.
- No documented resource caps, GPU or session timeouts. Each Schedule has a "safety limit" (0.5.28), whose meaning is undefined [UNVERIFIED].
- Sources added for E: https://myturnstone.ai/learn, https://myturnstone.ai/howto, changelog 0.1.8, 0.5.8, 0.5.10, 0.5.20, 0.7.4, 0.7.5, 0.7.10–0.8.7.

## F. Scenario: nightly scrape -> CSV on ChatGPT subscription, laptop off

**F1. Verdict**

- **Hosted plan: No (today).**
  - The only laptop-off path is Turnstone Cloud. https://myturnstone.ai/plan shows it as "Add-on · Coming soon… Join the waitlist" (seen 2026-11-13). The privacy page calls it a "limited-access beta… not available to all users".
  - No public doc shows a Cloud run, or any scheduled run, using a ChatGPT or Codex subscription.
  - When Cloud is available, the official claim is only "Cloud Schedules can run while your Mac is offline" (https://myturnstone.ai/howto); subscription use there is [UNVERIFIED].
- **Self-hosted VPS: No.** No self-host build exists: the app is proprietary and Mac-only (https://myturnstone.ai/terms; /facts says Windows and Linux are "Not available").
- **Laptop on and awake:** works locally. "Local Schedules run while Turnstone is open and your Mac is awake" (/howto); "run only while Turnstone is alive" (https://docs.myturnstone.ai/concepts/automations).

**F2. ChatGPT subscription in the cloud (the crux)**

- **Locally:** "Your own ChatGPT plan, through the official Codex app and OpenAI's own login" (/facts). The app drives a local Codex process ("retries a stalled Codex startup", changelog 0.5.15). Tokens are [INFERENCE] in Codex's local store, and Codex refreshes them.
- **Moving the token to Cloud:** undocumented.
  - "Cloud setup explains what moves and which connections need attention" (0.8.7).
  - "Cloud provider credentials use server-controlled encryption. Turnstone's service can decrypt them" (privacy).
  - [INFERENCE] Some provider credentials are copied server-side. Whether ChatGPT or Codex OAuth tokens are included, how unattended refresh works, and whether it conflicts with the laptop's Codex login are all [UNVERIFIED].
  - If tokens are used from the cloud, model calls would come from vendor infrastructure (AWS or E2B per privacy) [INFERENCE]. No ToS or IP-risk statement exists.
- **Relay through the laptop:** there is no documented relay of local CLI model calls. The phone and web relays only control the Mac (0.5.2, 0.7.0); a relayed model call would die with the laptop off [INFERENCE].
- **Alternatives the vendor offers:**
  - Turnstone Credits for managed models: "$10 in Credits costs $11.18" (/plan).
  - Your own API key.
  - The old Early Access plan bundled "managed model routing, Schedules, cloud execution" (0.6.5–0.7.1). [INFERENCE] Cloud may lean on managed models.
- **Expiry and limits:** "Reconnect a stale ChatGPT or Claude subscription before starting new work" (0.1.7) suggests a human re-login. "Scheduled work can recover when… a service limit is reached" (0.5.35) and "Local scheduled work… with recovery for eligible connected subscriptions" (0.7.9) are both local-scoped statements.

**F3. Setup UX (as documented, laptop-on; Cloud steps unknown)**

1. Download the Mac app (signed DMG, 0.5.3).
2. Settings → Models: sign in to ChatGPT through the Codex app or OpenAI login (/facts; 0.5.36 for multiple accounts).
3. Create or choose an Agent and select its folder (/learn).
4. **Human step:** log in to site X in the Turnstone Browser, or import a Chrome or Arc profile (docs/browser). 2FA and captcha are handled by the human.
5. Say "Every night at 03:00, go to X, extract … and save data.csv". The Agent proposes a Schedule, and you approve the review card (docs/automations). Timezone: no field documented [UNVERIFIED].
6. Set the permission mode to Always Allow so writes don't wait for approval. Sensitive connected-app actions may still require review (docs/permissions).
7. A run-now or test button is not documented [UNVERIFIED]. Past runs are viewable (0.5.32).
8. **Cloud:** join the waitlist. Once you get access, you go through "Cloud setup", with steps unpublished.

**F4. Execution at 03:00**

- **Local:**
  - The in-app scheduler fires; nothing wakes a sleeping Mac (not cron or launchd, per docs/automations).
  - The Agent starts with clean context, scrapes with the embedded headed browser (JS-capable, saved profile cookies), and writes the CSV with file tools into its folder (/learn).
  - The result goes to a Side Chat and the Inbox. Recovery covers broken connections and service limits (0.5.35), and run history exists (0.5.32).
  - Failure notification beyond the Inbox and phone app is undocumented.
- **Cloud:** "Cloud computers can retain files and browser sessions", possibly E2B (privacy). Local browser cookies are "not included in Turnstone's cloud account sync" (docs/browser), so the site login must be re-established in the cloud browser [INFERENCE]. The scheduler or queue technology is [UNVERIFIED].
- **Captcha, bot walls, stealth:** none documented.

**F5. Getting the CSV out**

- The Agent's folder on the Mac, or the Library (0.8.2).
- A Side Chat or Inbox result, with downloadable chat artifacts (homepage).
- Phone app previews (0.8.7).
- Possibly email from the Agent's own address at agent.myturnstone.ai (0.5.28), or Gmail, Slack or Drive via connectors [INFERENCE].
- No public API or git output is documented.

**F6. Gaps and risks**

- The decisive gap is Cloud availability (waitlist) plus undocumented subscription support in Cloud.
- **Cost:**
  - Local: $0 to Turnstone; usage counts against the ChatGPT plan (/facts).
  - Cloud: $49/mo after one free month (homepage). No compute-hour metering is published.
  - Credits fallback: pay-as-you-go at provider prices plus a fee.
- **Silent misses locally:** the Mac asleep or the app quit (no catch-up documented); Ask First mode blocking on approval; a stale subscription (0.1.7).
- **Site risks:** bot blocking with no documented stealth; site login cookies don't transfer to Cloud.
- **ToS:** no documented position on running a ChatGPT subscription from vendor cloud IPs [UNVERIFIED].
- Sources: /plan, /howto, /facts, /learn, /privacy, /terms, docs/automations, docs/browser, docs/permissions, changelog 0.1.7, 0.5.0–0.5.36, 0.6.5–0.8.7.
