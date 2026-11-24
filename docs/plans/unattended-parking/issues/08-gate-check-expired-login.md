# 08: Gate check: an unattended routine parks on takeover, approval and question, and resumes after my answer

Reworked 2026-11-19 after the credential vault removal (`f95d6cd`): `browser_login` and vault grants no longer exist. Logins come from takeovers only, and a routine on a sign-in page reports the source as unavailable without parking.

**What to build:** Run the check that closes step 1 of the cancel gate on my VPS, and record the result here. A scheduled routine meets a human step (takeover, approval, question), parks, and finishes after I answer. See `docs/plans/grok-bot-replacement-roadmap.md`, "The cancel gate", step 1.

**Blocked by:** 02, 03, 04, 06, 07, 09

**Status:** ready-for-human

Needs the VPS host (with `tailscale serve` giving the UI an HTTPS address on the tailnet) and a phone on the tailnet. Telegram is not needed here (step 3 adds the ping); the phone opens the web UI. If the live view does not take touch input on the phone, note it: the takeover then waits for the laptop inside the 24-hour park, and a mobile live view becomes its own task (ADR-0010).

Set up once. Create a bot with the browser on and a routine named "gate check" scheduled ahead (e.g. `0 3 * * *` or a few minutes out for a trial) in my time zone. Its instruction asks the bot to open a page that requires human intervention (e.g. a CAPTCHA demo like `https://www.google.com/recaptcha/api2/demo` or a site needing a takeover), call `browser_request_takeover`, and after I hand back report what the page says.

- [ ] **The headline (takeover park).** The scheduled routine runs, hits the step needing a human, calls `browser_request_takeover` and parks. The run shows `waiting` in the Routines panel. Record the run id _(park verified in `b39ebeea`, Telegram card `7624134751:23`; still needs owner's interactive phone takeover + "I'm done" completion)_
- [ ] The sidebar shows the bot with a Needs-you count of 1 (its source named "gate check", the routine), the desktop banner counts it if the app is hidden, and the takeover card is in its chat and in the Needs-you bar (Enter on the bar row only scrolls to the card). On the phone (or laptop), over the tailnet, I open the bot, see the live view, finish the step, and tap "I'm done". The 30-minute inactivity limit starts only at my first input
- [ ] The run resumes in the same session and ends `succeeded` with the post-takeover result in its output. The transcript shows no repeated steps before the resume. The run history shows one run, not two
- [x] The next scheduled occurrence runs normally, and an occurrence that came due while the run was parked (set the schedule to every few minutes for one trial) was recorded `skipped` with "previous run is waiting for you"
- [ ] **An approval:** a routine that calls an `ask`-policy tool parks, I Allow it on the phone, and the run finishes. A Deny with a note on another run reaches the bot and the run finishes, saying what it could not do. After "Always allow <tool> for this bot" a second run with the same tool never parks; the rule shows under the bot panel's Permissions section, and Remove makes the next run park again
- [x] **A question:** a routine that calls `ask_user` parks and my answer reaches it
- [x] **A background-tasks bot** (if the gate bot is one, or a second bot): its routine runs headless in a session of its own, parks like a standard bot's, and reports through the run output and the Routines panel; its front chat sees neither the routine nor the answer
- [x] **A restart:** with a run parked on an approval or a question, restart the host (`systemctl restart`); the run stays `waiting`, its card replays, and answering after the restart resumes it. A run parked on a takeover is different by design: the restart cancels the takeover, the run resumes with "the browser session is gone" and the bot may request a new takeover (record what it did)
- [x] **An expiry:** leave one park open past 24 hours (or move the clock on a staging copy); the run is `failed` with "approval expired"
- [x] **A login wall:** a routine opens a page that asks for a sign-in; the run finishes `succeeded`, skips that source and names it in its report (`Unavailable: ...`). It does not park
- [x] **A bot wall:** a routine opens a site that shows a Cloudflare, DataDome, PerimeterX or Imperva interstitial from the VPS's IP. Record what happened: waited out, handed off as a takeover, or not detected. A site that never passes is a known limit of the decision, not a failure of this check
- [x] **Memory:** the 4 GB VPS held one parked takeover and the next routine without running out of memory (`free -h` and the unit's memory use, recorded)
- [x] `docs/browser.md` matches what was seen. The date, the run ids and any gap found are written under `## Comments`; each gap becomes a ticket in this folder

## Comments

- **2026-11-19 (VPS `vps.tail3b8f5e.ts.net`, fresh `tomte` install, Claude CLI `2.1.328`, `agent-browser 0.41.2`, Chrome `158.0.8127.36`):**
  - **Question park + skipped occurrence + restart + resume:** Run `9c66691c` parked in `waiting` (`ade88eea`, Telegram card `7624134751:19`); next tick recorded `skipped` (`68ab0262`, `"previous run is waiting for you"`); `systemctl restart tomte` kept `ade88eea` open; answering `"Blue"` resumed in the same session (`3e12af89`) and finished `succeeded` (`parkedMs: 121363`, `"The chosen color is Blue."`).
  - **Background-tasks headless routine:** Run `5308116f` parked in its own session (`3b41ac8d`), resumed on `"42"`, finished `succeeded` (`"Your favorite number is 42."`).
  - **24h expiry:** Observed live on this VPS (`2026-11-17`→`2026-11-18`, run `cbe748be`, `parked_ms: 86,446,921`, `status: failed`, `error: "approval expired"`, Telegram card `7624134751:4` closed on expiry).
  - **Login wall:** Run `5e39c1a5` opened `https://github.com/login` → `succeeded` without parking (`$0.0712`), output: `Unavailable: GitHub dashboard (https://github.com/login, login required)`.
  - **Bot wall:** Run `0920fdc1` opened `https://www.g2.com/` → DataDome interstitial detected and reported (`succeeded`, `$0.0223`), output: `Unavailable: g2.com (DataDome bot protection)`.
  - **Takeover park + memory + restart:** Run `b39ebeea` opened reCAPTCHA demo, parked in `waiting` (Telegram card `7624134751:23`). With parked Chrome + concurrent routine: `free -h` showed `1.1Gi` used / `2.6Gi` available / `0B` swap; `tomte.service` used `609.2M` (peak `683.2M`). On `systemctl restart tomte`, takeover wait `3fd2c66c` was cancelled, the run resumed with `"the browser session is gone"`, and the bot automatically requested a fresh takeover.
  - **Gaps found & fixed on VPS (to fold into `deploy/install.sh` and `deploy/README.md`):**
    1. Minimal Ubuntu 26.04 lacked 12 Chrome shared libraries (`libatk1.0-0t64`, `libatk-bridge2.0-0t64`, `libcups2t64`, `libasound2t64`, `libgbm1`, `libcairo2`, `libpango-1.0-0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libatspi2.0-0t64`).
    2. With `kernel.apparmor_restrict_unprivileged_userns=1`, Chrome's own sandbox also needed an AppArmor `userns` profile (`/etc/apparmor.d/tomte-chrome` for `/var/lib/tomte/.agent-browser/browsers/*/chrome`); previously only `/usr/bin/bwrap` had one.
  - **Still open (owner interactive):** Complete a takeover from the phone (`telegram-channel/issues/07-phone-takeover-check.md`) and test an `ask`-policy integration tool approval (`Allow`, `Deny` with note, `Always allow` + remove).
