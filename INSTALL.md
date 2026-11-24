# Installing Tomte (instructions for an AI assistant)

You are an AI coding assistant helping a person install Tomte, a host that runs Claude bots on their own machine. Follow these steps in order. Run each check and read its output before moving on. Stop and ask the person only where a step says **ASK**; never invent a token, a code or a sign-in.

Rules:

- Do not print, log or store any secret you are shown (a pairing code is fine to show to the person; a Claude sign-in code, Telegram token or device token is not).
- Do not change files outside the folders named here. Do not use `sudo` except in the server path.
- If a check fails, report the exact output and stop; do not work around it.

## 0. Choose the path

Ask which of these the person wants (**ASK** if unclear):

| Path            | For                                                          |
| --------------- | ------------------------------------------------------------ |
| A. Desktop app  | macOS, Windows or Linux desktop, one person, the simplest    |
| B. Linux server | An always-on host reachable from a phone; systemd Linux only |
| C. From source  | Contributors                                                 |

There is no release yet. Until the first one is published, paths A and B have nothing to download: tell the person so and use path C.

Detect the platform: `uname -sm` (macOS/Linux) or `$env:OS` (Windows).

## A. Desktop app

1. Open the [latest release](https://github.com/nikolasbarwicki/tomte/releases/latest) and download the installer for the platform (macOS: `.dmg`, choose `arm64` on Apple silicon, check with `uname -m`; Windows: `Tomte-Setup-<version>.exe`; Linux: `.AppImage` or `.deb`).
2. Optional integrity check: download `SHA256SUMS` from the same release and compare (`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux).
3. Install it. Builds are not signed yet, so **ASK** the person to approve the OS warning: macOS, right-click Tomte.app → Open; Windows, SmartScreen → More info → Run anyway.
4. Launch Tomte. On first launch it installs the Claude CLI and the browser engine in the background; wait until Settings → Models shows the CLI version.
5. **ASK** the person to sign in: the sign-in on the Models page in Settings. They open the URL shown, approve, and paste the code back. You cannot do this for them.
6. Verify (below). Then create a bot and say hello.

## B. Linux server

Requirements: systemd, root over SSH, outbound internet. Remote mode is Linux only ([ADR-0006](docs/adr/0006-remote-mode-is-linux-only.md)).

1. Check the prerequisites: `command -v curl sha256sum systemctl runuser useradd`. All must print a path.
2. Read [deploy/README.md](deploy/README.md) sections "Prerequisites" and "Ubuntu user namespaces". On Ubuntu 24.04 the installer warns about bubblewrap; follow the AppArmor profile there rather than disabling the sysctl globally.
3. **ASK** whether the server has a domain name (HTTPS with Caddy) or uses Tailscale. The installer's flags for each are in deploy/README.md.
4. Install:
   ```sh
   curl -fsSL https://github.com/nikolasbarwicki/tomte/releases/latest/download/install.sh | sudo bash
   ```
   Add the flags from step 3. The installer is safe to re-run.
5. The installer prints a pairing code (12 characters, valid 10 minutes, single use) and the exact `tomte-host auth-login` command. Show the code to the person and have them enter it at the server's URL. **ASK** them to run, or to be present for, the `auth-login` command: it prints a URL they open in their own browser.
6. Verify (below).

Undo: deploy/README.md, "Uninstall". The installer has no uninstall mode; the data root `/var/lib/tomte` is kept unless you remove it, and removing it deletes every bot, chat and secret, so **ASK** first.

## C. From source

1. Check `bun --version` against `.bun-version`; install Bun from <https://bun.sh> if missing.
2. `git clone https://github.com/nikolasbarwicki/tomte.git && cd tomte && bun install`
3. `bun run host install-cli` (the managed Claude CLI).
4. `bun run build:web`, then `bun run ui` starts the host (it stops with "no web UI build" without the first). **ASK** the person to sign in under Settings → Models.
5. Optional: `bun run check` runs every gate (needs several minutes).

## Verify

The host answers without a token at `/api/host-info`. Use it for a server (its public URL) or a source run (the URL `bun run ui` prints). For the desktop app, skip the `curl` and check the UI instead.

```sh
curl -fsS <url>/api/host-info
```

Expect JSON with `version`, `apiVersion` and `mode` (`local` for the desktop and source paths, `remote` for a server). Anything else is a failure: report it. Then confirm in the UI that Settings → Models shows the Claude account as signed in.

## Optional: Telegram

Only if the person wants their phone to receive questions and results. **ASK** them to create a bot with @BotFather and paste the token into Settings → Channels (do not ask them to paste it to you), then use the link code shown there.

## Finish

Tell the person what you did, the URL, which steps they performed themselves, and where to read more: [README](README.md), [FAQ and troubleshooting](docs/faq.md), [your data](README.md#your-data).
