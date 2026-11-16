# Bot browser

Each bot can have its own real Chrome browser. It is off by default. The bot drives it through browser tools (open a page, read a snapshot, click, fill, type, press keys, select, scroll, screenshot, read text, tabs, back). The browser keeps the bot's logins between tasks and across claudebot restarts, encrypted at rest with a key held in the OS keychain.

Use `WebFetch` and `WebSearch` for plain reads. The bot is told to reach for the browser only for JavaScript-rendered pages, logins and interaction.

Screenshots and pages too large for one result are saved in the `browser/` folder of the bot's files area so the bot can read them. That folder is hidden from the Files panel and emptied when the bot starts a new session; copy anything you want to keep out of it first.

## Install the engine

The desktop app ships the browser: its bundle holds the pinned engine and a pinned Chrome for Testing (157.0.8103.38, full Chrome rather than the headless shell so bots can run headed), both checked against SHA-256s in claudebot's source when `bun run package:desktop` builds it (`scripts/browser-bundle.ts`). They sit in `browser-engine/` next to the host binary, and the host finds them there, so a fresh install needs no download. If that copy is missing anyway, the desktop host installs the browser below in the background and the Browser tab says it is installing; a failed install is retried the next time the browser is switched on or used.

A host started from source or as a standalone binary installs it with:

```sh
bun packages/host/src/host.ts install-browser
```

This does two things:

1. Downloads the **pinned** `agent-browser` engine release (v0.41.2) for your platform from GitHub, checks it against a **SHA-256 pinned in claudebot's source**, and marks it current under `agent-browser/` in the data root (set the data root with `--data-root` or `CLAUDEBOT_DATA_ROOT`).
2. Runs the engine's own installer to fetch **Chrome for Testing**.

Chrome for Testing is **not pinned and not checksum-verified by claudebot**. The engine's installer fetches whatever is the current Stable release at install time, and Chrome lands in `~/.agent-browser/browsers`. Only the engine binary is pinned. Two machines installed at different times can have different Chrome versions, and nothing auto-updates either one.

Your own Chrome is never used. If Chrome for Testing is missing, the browser is unavailable rather than falling back.

The engine keeps its state and sockets in `~/.agent-browser` of the user running claudebot, not in the data root. Agent-browser 0.41.2 has no state-directory option, and its socket paths are limited to 103 bytes, which a data-root location would exceed on macOS.

Engine lookup order: `AGENT_BROWSER_PATH`, the bundled copy, the managed install, then `agent-browser` on `PATH`. Chrome lookup order: `AGENT_BROWSER_EXECUTABLE_PATH`, the bundled copy, then the newest one in `~/.agent-browser/browsers`.

## Enable the browser for a bot

Open the bot's side panel (the panel button at the top right of the chat) and go to the **Browser** tab. Turn on the **Web browser** switch. When the switch is disabled, the reason is shown below it:

| Reason                                   | Fix                                                                                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser engine not installed             | Run `bun packages/host/src/host.ts install-browser`.                                                                                                                                                                                          |
| Chrome for Testing is not installed      | Run `bun packages/host/src/host.ts install-browser`.                                                                                                                                                                                          |
| No `agent-browser` build for this OS/CPU | Not supported on this machine.                                                                                                                                                                                                                |
| The shell sandbox is unavailable         | macOS needs `/usr/bin/sandbox-exec`. Linux needs `bwrap` and `socat` installed (on Ubuntu, an AppArmor user-namespace restriction can also stop `bwrap`; fix the restriction, do not run unsandboxed). Windows has no sandbox, so no browser. |

The sandbox is required because a browser-enabled bot runs its shell commands inside Claude Code's sandbox (see [Safety](#safety)). The browser never runs a bot unprotected.

Enabling the switch shows the browser's live view and controls in the Browser tab. The browser itself starts on the bot's first browser call, not when you enable the switch.

### Panel controls

The **⋯** menu next to the browser's status holds:

- **Show window**: runs Chrome with a visible window on your computer, for sites that block headless browsers. Restarts the browser.
- **Restart browser**: closes the browser and keeps saved logins. Use it to recover a stuck browser. The bot is told it restarted and must take a fresh snapshot.
- **Sign out of everything**: closes the browser and deletes its saved login state (asks for confirmation). Grants and vault entries are untouched.

A browser nobody used for 10 minutes closes on its own, keeping its logins. All browsers close when claudebot shuts down, and leftover engine and Chrome processes from a crash are closed on the next start (and swept every minute).

## Live view

The Browser tab shows a live picture of the bot's browser with its tabs and current URL. Opening the tab never starts a browser; a stopped browser shows a placeholder ("The browser is not running. It starts when <bot> first uses it."). The view is view-only while the bot is in control, and a slow connection gets the latest frame rather than a backlog.

## Takeover

When the bot hits something it cannot do (CAPTCHA, 2FA code, passkey, a login it cannot finish), it requests a takeover with a one-line reason.

1. A **Needs you** card appears in the bot's chat with the reason and the buttons **I'm done** and **Skip**. The side panel switches to the Browser tab on its own. The card survives closing and reopening the UI.
2. You control the browser from the live view: click and type in the picture.
3. **I'm done** resumes the bot with a note to take a fresh snapshot. **Skip** tells the bot you did not complete the step, so it can try something else or report back. The bot receives each outcome as a `<human-wait-result id="…">` message.

You can also **Take control** at any time without a request, then **Hand back**. While you hold control the bot's browser calls are refused with "user has control", and a call already running finishes before you get control. A takeover you start yourself sends the bot no message, unless it was refused a call while you held control, in which case it is told control has returned.

A takeover with no input from you for **30 minutes** ends on its own and counts as **Skip**. A takeover request is also a stored human wait that expires after 24 hours. Restarting claudebot closes the bot's browser, so an open takeover request is cancelled at the next start and the bot is told its browser session is gone, so it can ask again.

What you type and click during a takeover is sent straight to the browser. It is never logged, never written to the transcript, and never shown to the bot. A password you type in a takeover stays private, but the page you land on afterwards is visible to the bot in its next snapshot.

## Credential vault and grants

Open **Credentials** to add website logins: a label, a sign-in URL, a username and a password.

- The sign-in URL must be `https` (plain `http` is accepted only for localhost, for testing). The entry is bound to that URL's origin (scheme, host, port).
- The password is stored **only in the host's secret store** (the OS keychain, or the encrypted secrets file in remote mode). It is not in claudebot's database or files, and no screen or API returns it. Editing an entry with an empty password keeps the old one.
- A bot can list entries by label and site (never secrets) and sign in by naming one with `browser_login`. The password never reaches the model, transcript, tool arguments or tool output.
- The engine fills the password only on a page matching the entry's origin.
- **First use needs your approval.** The bot's chat shows an approval card (**Allow** / **Deny**). Allow creates a **grant** for that bot and that entry; the bot is told to call `browser_login` again. The grant is remembered. The approval is a stored human wait: it stays open across a claudebot restart, and an answer given afterwards still reaches the bot as a message. It expires after 24 hours without an answer.
- **Revoke** a grant per entry or in "Access by bot" in the Credentials screen; the bot asks again next time. Deleting an entry removes its password and all its grants.
- If the vault cannot finish a sign-in (multi-step login, OTP, passkey), the bot is told to request a takeover.

## Routines (unattended runs)

Scheduled routines of a browser-enabled bot can browse using the bot's existing logins. They cannot sign in with the vault yet: `browser_login` is refused with "not available in unattended runs". A routine that hits a login wall is told to say so in its run result, so check run results and sign the bot in again from chat. A routine and the bot's chat never drive the browser at the same time; a second call waits up to 30 seconds, then fails with "previous browser call still running".

A routine can request a takeover, and that parks the run: it shows "Waiting for you", the bot's Chrome stays open on the page it was on, and the bot's browser is held, so another run of the same bot that calls the browser meanwhile is refused with "user has control" and reports it. Open the bot, use the live view (on a phone, the bot panel's sheet), then press **I'm done** or hand the browser back, and the run continues in the same session; **Skip** continues it too, with the bot told you did not handle it. The 30-minute inactivity limit does not run while the takeover waits for you: it starts at your first input and then counts between inputs, and a timeout counts as Skip. Until your first input only the 24-hour limit applies: an unanswered takeover fails the run with "approval expired" and releases the browser. Restarting claudebot closes the browser, so an open takeover is cancelled at the next start and the run continues with a message that the browser session is gone, so the bot can ask again.

A routine that needs an approval or an answer does not fail. A tool on the `ask` policy, or a question to you, parks the run: it shows "Waiting for you", you answer on the usual card (open the bot), and the run continues in the same session. A park that stays unanswered for 24 hours fails the run with "approval expired". While a run waits, the routine's next occurrences are skipped and "Run now" is unavailable.

## Safety

- **Egress block.** Chrome's traffic goes through a claudebot-run proxy that resolves DNS itself and refuses loopback (every port, which covers claudebot's own server, the browser endpoint and the engine's control and stream ports), link-local including the cloud metadata address `169.254.169.254`, and `0.0.0.0/8`. Redirects and DNS rebinding are covered because the check is on the resolved address. Public internet and private LAN addresses are allowed. A test page you want a bot to open therefore cannot be on `localhost`.
- **Claude sandbox for the shell.** Bots with the browser enabled run shell commands inside Claude Code's sandbox (required, never optional). Reads of the engine state directory (`~/.agent-browser`) are denied for both the shell and the Read tool. On macOS, `~/Library/Keychains` is denied too, because the sandbox always allows the keychain service and a bot could otherwise read claudebot's keychain items with `security`. The sandbox's blocking of loopback and local sockets keeps shell commands away from the engine and the host. Ordinary outbound shell traffic still works.
- **Bots cannot drive the engine.** The bot reaches the browser only through its MCP connection to a host-owned endpoint (see [ADR 0001](adr/0001-browser-engine-behind-host-mcp-endpoint.md)). That endpoint needs a per-session bot token and rejects web pages. The engine runs with a default-deny action policy: no JavaScript evaluation, file upload or download, network interception, state import/export, or cookie editing.
- **Page content is untrusted.** Snapshots and page text are wrapped in per-call markers and labelled as page content, not instructions.
- The live view and input routes accept only same-origin JSON requests, so a website cannot inject clicks into a signed-in bot browser.

## Known limits

- **Google sign-in rejects automated Chrome**, headless or headed, even under takeover.
- **Cloudflare Turnstile can fail even under takeover.**
- Sites that fingerprint browsers may block the browser. There is no CAPTCHA solving or stealth.
- No file upload or download, no JavaScript evaluation.
- Chrome for Testing is unpinned (see [Install the engine](#install-the-engine)).
- Linux depends on `bwrap` and `socat`; without them the browser stays unavailable.
- Deleting a bot signs it out of everything (saved logins and engine session removed), ends any takeover and removes its credential grants.
