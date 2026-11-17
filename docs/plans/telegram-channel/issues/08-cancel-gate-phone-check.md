# 08: Cancel gate check: approve an email from my phone with the laptop closed

**What to build:** Nothing to build. This is gate step 3 of `docs/plans/grok-bot-replacement-roadmap.md`: "I approve an email from my phone while the laptop is closed, and the run finishes." It runs against my real VPS host, my real Telegram bot and a real send tool. When it passes, step 3 of the cancel gate is done.

The Outreach researcher's real job is the target: its policy is "every send asks and parks" (the Hostinger email MCP's send tool at the default `ask` policy, ADR-0009). The check uses a throwaway routine so that no real outreach is sent.

**Blocked by:** 04, 05, 06

**Status:** ready-for-human

Before starting:

- [ ] Gate step 2 is done: the host runs on the VPS under its own user, in remote mode, behind `tailscale serve`, and the desktop app connects to it as a remote profile
- [ ] The Telegram bot exists (from `@BotFather`), its token is pasted on the Channels page (the page then says the bot is running with its username; a rejected token says "the bot token was rejected", and another poller or a webhook on the same bot is reported as such), and my account is linked with "Link account" (a one-time code, valid 10 minutes, sent to the bot or opened through the `t.me/<bot>?start=<code>` link; tickets 01 and 02). A message from a second Telegram account to the bot gets no reply (check once with a friend's account or a second one of mine)
- [ ] The email integration (Hostinger email MCP) is connected on the VPS host and its send tool is at `ask`. Pick the bot (the Outreach researcher or a scratch bot) and note the policy
- [ ] A routine "Gate check: send to myself" on that bot, "Send the result to my phone" on, scheduled a few minutes ahead (a `once` schedule is enough). Instruction: send one short email to my own address with the subject "tomte gate check", then report that it was sent. Keep the body short: an approval whose input is over 2400 characters is cut on the card and offers Deny only (approve such a send in the web UI)
- [ ] The phone has Tailscale connected, and Telegram notifications are on for the bot

The check:

- [ ] Close the laptop (lid shut, desktop app quit, so nothing of tomte runs on it) before the routine's time. Use only the phone from here
- [ ] At the scheduled time a card arrives on the phone: the send tool's name, the reason and the exact input (recipient, subject, body) as plain text, with "Allow", "Always allow <tool> for this bot" and "Deny" buttons and an "Open in Tomte" link to the web UI. Do not press "Always allow" (it stores a rule and later sends stop asking). In the web UI on the laptop, earlier or afterwards, the run shows `waiting`, not `failed`
- [ ] Read the exact input on the card. Press Allow
- [ ] The card changes to "Answered: Allow" and loses its buttons. The run resumes in the same session and finishes `succeeded`. The email arrives in my inbox, exactly once, with the input the card showed
- [ ] The result message arrives in Telegram: "Gate check: send to myself: <the run's summary>" and an "Open in Tomte" link. The link opens the Routines panel on the phone's browser
- [ ] Open the laptop afterwards: the run shows `succeeded`; the card in Telegram is still handled; the web UI shows no open wait and no needs-you item left over
- [ ] Repeat once with Deny by replying to the card with a note ("use the other address"); the reply denies the approval and the note reaches the bot. The card changes to "Answered: Deny". The run finishes, the bot reports it did not send, and no email arrives
- [ ] Repeat once and leave the card for the 24-hour expiry (or move the clock on a scratch host): the run fails, the card changes to "Expired", and one notice arrives, "Gate check: send to myself: <wait title> expired, so the run failed", with no separate "Routine … failed" message
- [ ] Record the date, the host version and any friction under `## Comments` below. If every check above passed, gate step 3 is done: note it in `docs/plans/grok-bot-replacement-roadmap.md`
