# FAQ and troubleshooting

## Questions

**Is Tomte free?** Yes. The code is AGPL-3.0 ([ADR-0013](adr/0013-agpl-license-cla-and-reserved-name.md)) and there is no paid tier. Bots run on your own Claude subscription.

**Do I need an Anthropic API key?** No. Tomte uses the Claude CLI's sign-in (Pro or Max). An API key or an Anthropic-compatible gateway also works: Settings → Models.

**Where does my data go?** Everything Tomte stores stays in its data root on your machine. It leaves only to Anthropic (every bot turn), and to Telegram, integration providers, websites and GitHub's update check when you use them. The full table is in the [README](../README.md#your-data); who can reach what is in the [threat model](threat-model.md).

**Does it work on Windows and Linux?** The host does. Server (remote) mode is Linux only ([ADR-0006](adr/0006-remote-mode-is-linux-only.md)). The Windows and Linux desktop installers are built by CI and have not been run yet ([features](features.md#unverified)).

**Is it a Grok Bot alternative?** Yes: bots that run routines, ask before risky actions and reach you on your phone, on your machine and under an open source license. See [compare.md](compare.md). Not affiliated with xAI or Anthropic.

**Can I use other models?** Any Claude model your plan allows, chosen per bot. Other providers work through a custom Anthropic-compatible gateway. A second harness is on the [roadmap](roadmap.md).

**Does it run when my laptop sleeps?** No: a sleeping computer runs nothing. When it wakes, a routine with "catch up" on runs its latest missed occurrence if one was due within the last 12 hours; anything older is recorded as skipped ("missed while offline"). For always-on bots use a Linux server ([deploy kit](../deploy/README.md)).

**How is it different from Claude Code?** Claude Code is the engine each bot runs on. Tomte adds what a bot needs to work without you watching: schedules, a needs-you inbox, approvals that wait for you, a browser, phone delivery and a desktop app.

**What can a bot do without asking?** Whatever its tool policies allow. Each integration tool is `off`, `ask` or `auto`; creating a new bot always asks; an unattended run that meets an `ask` tool waits for you for up to 24 hours ([ADR-0009](adr/0009-unattended-runs-park-on-durable-human-waits.md)).

## Troubleshooting

**macOS says the app can't be verified / Windows SmartScreen blocks the installer.** Builds are not signed yet. macOS: right-click Tomte.app → Open, once. Windows: More info → Run anyway. Auto-update of an unsigned macOS app is not expected to work; download the new version instead.

**The Claude sign-in is stuck.** Settings → Models shows the sign-in state. Start the sign-in again from there and paste the code the browser shows; Cancel ends a waiting sign-in, which also ends by itself after 10 minutes. On a server, run `tomte-host auth-login` as the service user.

**The browser says it is installing.** The desktop app installs the browser engine in the background on first launch; until it finishes, a browser bot reports that. On a server or from source, run `tomte-host install-browser` (`bun run host install-browser`).

**Telegram: "the bot token was rejected".** Telegram answered 401, so the token is wrong or was revoked. Create a new one with @BotFather and paste it in Settings → Channels. A 409 means another program is polling the same bot; stop it.

**Telegram: nothing happens when I send the link code.** The code is single use and lasts 10 minutes, and ten wrong attempts invalidate all codes. Make a new one in Settings → Channels.

**`data root … is in use by the host running as pid …`.** One host owns a data root at a time through a lock. Quit the other one (the desktop app's tray, or `systemctl stop tomte`).

**Ubuntu server: bot shells fail with `bwrap: loopback: Failed RTM_NEWADDR`.** Ubuntu 24.04 restricts the user namespaces bubblewrap needs. The installer warns about it; the fix is an AppArmor profile for `/usr/bin/bwrap`, described in [deploy/README.md](../deploy/README.md).

**A routine is `waiting`.** It met an `ask` tool or a question and is waiting for you. Answer from the Work section, the needs-you card or Telegram; it resumes where it stopped. Unanswered after 24 hours, it fails with "approval expired".

**Something else.** Look at `logs/host.log` in the data root (the desktop app's own log is `logs/desktop.log` in its user-data folder) and open an issue with the relevant lines, tokens redacted. A `tomte-host doctor` command is on the [roadmap](roadmap.md).
