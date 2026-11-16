# 08: Gate check: a 03:00 routine meets an expired login, parks, and finishes after a takeover from the phone

**What to build:** Run the check that closes step 1 of the cancel gate on my VPS, and record the result here. A routine that runs at 03:00 meets an expired login, parks, and finishes after I take over the browser from my phone. Also walk the smaller parking cases once. See `docs/plans/grok-bot-replacement-roadmap.md`, "The cancel gate", step 1.

**Blocked by:** 02, 03, 04, 05, 06, 07

**Status:** ready-for-human

Needs the VPS host (gate step 2 is done, with `tailscale serve` giving the UI an HTTPS address on the tailnet), a real site where the bot has a login with a second step (a code or a passkey), and a phone on the tailnet. Telegram is not needed: step 3 of the gate adds the ping, and here the phone opens the web UI. If the live view does not take touch input on the phone, note it: the takeover then waits for the laptop inside the 24-hour park, and a mobile live view becomes its own task (ADR-0010).

Set up once. Create a bot with the browser on and a routine named "gate check" with a schedule of `0 3 * * *` in my time zone. Its instruction names the site, asks the bot to open its dashboard (signing in with the vault entry if needed) and to report one fact from it. Approve the entry's first use by hand in a chat so the grant exists. Then expire the login: use Sign out in the bot's Browser tab, which deletes its saved logins.

- [ ] **The headline.** At 03:00 the routine runs, finds the sign-in page, calls `browser_login`, gets `needs_another_step`, calls `browser_request_takeover` and parks. The run shows `waiting` in the Routines panel. Record the run id
- [ ] In the morning the sidebar shows the bot with a Needs-you count of 1 and the takeover card is in its chat and in the Needs-you bar. On the phone, over the tailnet, I open the bot, see the live view and finish the second step. I tap "I'm done"
- [ ] The run resumes in the same session and ends `succeeded` with the fact in its output. The transcript shows no repeated opening or sign-in steps before the resume. The run history shows one run, not two
- [ ] The next scheduled occurrence runs normally, and an occurrence that came due while the run was parked (set the schedule to every few minutes for one trial) was recorded `skipped` with "previous run is waiting for you"
- [ ] The vault: with the entry granted and the login expired but no second step needed, a scheduled run signs in with nobody and finishes, with no wait
- [ ] An approval: a routine that calls an `ask`-policy tool parks, I Allow it on the phone, and the run finishes. A second routine with the same tool after "Always allow for this bot" never parks
- [ ] A question: a routine that calls `ask_user` parks and my answer reaches it
- [ ] A restart: with a run parked, restart the host (`systemctl restart`); the run stays `waiting`, and answering after the restart resumes it
- [ ] An expiry: leave one park open past 24 hours (or move the clock on a staging copy); the run is `failed` with "approval expired"
- [ ] A login wall without a grant: a routine opens a page that asks for a sign-in the bot has no entry for; the run finishes, skips that source and names it in its report. It does not park
- [ ] A bot wall: a routine opens a site that shows a Cloudflare, DataDome, PerimeterX or Imperva interstitial from the VPS's IP. Record what happened: waited out, handed off as a takeover, or not detected. A site that never passes is a known limit of the decision, not a failure of this check
- [ ] The 4 GB VPS held one parked takeover and the next routine without running out of memory (`free -h` and the unit's memory use, recorded)
- [ ] `docs/browser.md` matches what was seen. The date, the run ids and any gap found are written under `## Comments`; each gap becomes a ticket in this folder
