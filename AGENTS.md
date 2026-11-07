## Checks

`bun run check` is the full gate; run it before calling work done. It runs, in order and stopping at the first failure: `fmt:check` (oxfmt), `lint` (oxlint, type-aware), `knip` (dead files, exports and dependencies), `typecheck` (tsgo, per package), `depcheck` (dependency-cruiser, ADR 0003 layering) and `test` (`bun test`). Each is also a script of its own. `bun run fmt` rewrites formatting in place.

`bun test` always runs with coverage (`bunfig.toml`: `coverage = true`, test files excluded, `text` and `lcov` reporters; `coverage/` is gitignored). Two gates apply, and `bun run test` (so `check` and CI) runs both:

- Per file: `coverageThreshold` makes `bun test` exit non-zero when any covered file's line or function coverage is below it. Bun applies it per file, not to the "All files" total, and only reads the plural keys `lines`/`functions` (singular keys are silently ignored; an omitted key defaults to 0.9). It is a floor: the lowest per-file value measured, rounded down to a whole percent.
- Total: `scripts/check-coverage.ts` sums `coverage/lcov.info` and fails when total line or function coverage is below its `BASELINE` constants, the measured totals rounded down to a whole percent. Bun only reports files that tests load, so a new module no test imports does not lower the total.

Raise both as tests land, never lower them; if coverage genuinely drops, add tests instead.

### Git hooks

Git hooks come from lefthook (`lefthook.yml`) and are installed by `bun install` via the `prepare` script; it skips quietly outside a git checkout.

- pre-commit (staged files, parallel): `oxfmt --check`, `oxlint`, `gitleaks git --staged`. A format failure means run `bun run fmt` and re-stage.
- commit-msg: `commitlint` checks the message against Conventional Commits (`commitlint.config.js`).
- pre-push: `bun run check`.
- Prerequisite: [`gitleaks`](https://github.com/gitleaks/gitleaks) is a Go binary, not an npm dependency. Install it yourself (`brew install gitleaks` on macOS); pre-commit fails with an install hint when it is missing.

### CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`/`master`. Jobs: `check` (`bun install --frozen-lockfile`, then `bun run check`), `pr-title` (pull requests only; commitlint on the PR title, since squash merges use it as the commit message), `sherif` (`bunx sherif`, monorepo dependency consistency), `secrets` (gitleaks over the full history, config in `.gitleaks.toml`) and `audit` (`bun audit`, non-blocking until it exits 0; then drop `continue-on-error` in the workflow). The Bun version comes from `.bun-version`.

Branch protection is repo settings, not code. Once the repo is on GitHub, require the `check`, `secrets`, `pr-title` and `sherif` jobs (not `audit` while it is non-blocking) (replace `OWNER/REPO` and the branch):

```sh
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["check","secrets","pr-title","sherif"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

## Host binary

`bun run build:host [target…]` builds the web UI, then compiles `packages/host/src/main.ts` with `bun build --compile` into `dist/host/claudebot-host-<os>-<arch>[.exe]` (gitignored) for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `windows-x64`; name targets to build only those. `scripts/build-host.ts` explains the x64 baseline, minify and sourcemap choices. The built web UI is embedded (`ui/assets.ts`); Vite, the Claude CLI and the browser engine are not.

`main.ts` is the one compiled entry and also runs from source: `[flags] [botId]` starts the server like `bun run ui`; `pair`, `install-cli`, `install-browser`, `browser-smoke`, `auth-status` and `auth-login` run the `host.ts` subcommands; `auth-status` and `auth-login` run the Claude CLI's `auth status` and `auth login` with the environment the host gives its bots' CLI children (in remote mode, which runs on Linux only and is refused on macOS and Windows (ADR-0006), the allowlist and `claude/` in the data root as `CLAUDE_CONFIG_DIR`); after a successful login, `auth-login` runs a fresh `auth status` and exits non-zero when it still reports signed out. `credential-plugin <url>` is internal (the browser engine spawns the binary with it). Any message that names a command goes through `platform/launch.ts` (`hostCommand`, `serverCommand`), so it names the binary or `bun run host` depending on how the host was started.

`--sidecar` (local mode only) is how the desktop app runs the host: it reads one launch-token line from stdin and registers it as the device "This computer" (replacing the previous launch device), prints one `SidecarReady` JSON line with its client URL to stdout (everything human-readable goes to stderr), installs the managed Claude CLI into the data root when none resolves, and shuts down gracefully, releasing the data-root lock, when stdin ends; without the flag the host never reads stdin. The shared shapes live in `@claudebot/contract/sidecar`.

`bun run smoke:host [binary]` (default: this machine's build output) runs a built binary for real: it copies it outside the repo, installs the managed Claude CLI with `install-cli` (unless `CLAUDE_PATH` names one), starts it on a temporary data root, pairs with `pair`, creates a bot, checks the event stream, loads the embedded UI (every asset `index.html` references, with the CSP), checks what the client listener refuses, stops it with SIGTERM and removes everything. It needs network for the CLI install and runs only a binary built for the machine it runs on (for a Linux binary in a container, compile the script with `bun build --compile --target=bun-linux-arm64 scripts/smoke-host.ts` and run both binaries there).

## Desktop app

`packages/desktop/` (`@claudebot/desktop`) is the Electron app. Its main process runs no host code (dependency-cruiser rule `desktop-only-to-contract`, ADR 0003): it spawns the host binary with `--sidecar`, writes a fresh launch token to its stdin, keeps the pipe open, waits for the ready line, sets the `claudebot_session` cookie in its own session and loads the host's client URL. The window has context isolation and the sandbox on, no Node and no preload. Navigation is limited to the host's origin; other web URLs and every `window.open` go to the system browser or are denied (`navigation-policy.ts`). Quitting ends the sidecar's stdin and waits for the host to exit; if the app dies, the host sees EOF and stops itself. It keeps its own user-data folder, `Claudebot Desktop` under the OS app-data folder, apart from the host's data root; `--user-data-dir` overrides it.

Closing the window hides it (and the dock icon, on macOS); the app and the host keep running in the tray (`background.ts`). The tray (`tray.ts`, menu in `tray-menu.ts`) has a template icon (`packages/desktop/assets/trayTemplate.png` and `@2x`, drawn by `bun run icons:desktop`, copied next to the bundle by `build:desktop`), shows the host's state (starting, running, stopped) in its tooltip and first, disabled item, and offers one radio item per connection profile (the active one checked) and Manage Connections…, Open Claudebot, Start at login, Restart host (only while stopped, with a fresh launch token) and Quit Claudebot. The state comes from `supervisor.ts`, which follows the sidecar's `exited` promise. Every way of quitting (tray, app menu, Cmd+Q) ends in `app.quit()` and the `before-quit` handler in `main.ts`, which ends the host's stdin and waits for it (bounded, then kill) before exiting.

Start at login is a desktop setting in `settings.json` in the user-data folder (`{ "startAtLogin": boolean }`, Zod-parsed; a missing file is a first launch and means true, an unreadable one means false and is left alone). Every launch applies it to the OS through the `LoginItem` interface (`login-item.ts`); the tray checkbox changes the file and the login item (`start-at-login.ts`). The OS implementation (`electron-login-item.ts`) calls `app.setLoginItemSettings` and passes `--hidden`; an app the OS opened at login (`wasOpenedAtLogin`, or `--hidden`) starts with its window hidden. When `CLAUDEBOT_DESKTOP_LOGIN_ITEM_FILE` names a file, the login item is recorded there as `{ "openAtLogin": boolean }` instead and the OS is never asked: every smoke and test on a developer machine sets it, so nothing registers itself at login.

- `bun run build:desktop` bundles the main process to `packages/desktop/dist/main.cjs` (gitignored).
- `bun run package:desktop` builds the host for this machine, bundles the main process and runs `@electron/packager` (asar on, no signing, no notarization) into `dist/desktop/`. The host binary is copied in as the extra resource `claudebot-host`.
- `bun run smoke:desktop [app]` (macOS only) drives the packaged `.app` with `playwright-core`'s `_electron.launch` on a fresh temp root that holds the data root, the Electron user-data folder and the file-secrets key, and passes `--use-mock-keychain`, so nothing reaches the keychain or a default folder. It checks, over four launches: a first launch that installs the managed Claude CLI (needs network); the signed-in UI; the renderer's isolation; the navigation and `window.open` policy; the UI's OAuth connect reaching `shell.openExternal` against a loopback fixture provider (the call is a recording stub, plus, with `SMOKE_SYSTEM_BROWSER=1`, one real call to a loopback fixture that opens a tab in the default browser); `kill -9` of the app stopping the host, its Claude CLI child, the browser engine and Chrome; closing the window leaving the host running while a routine (a `once` schedule) fires; the tray's tooltip and menu, "Open Claudebot", killing the host alone and "Restart host"; Start at login on after the first launch, off after the tray checkbox and still off after a relaunch with `--hidden`; the tray's Quit and a graceful `app.quit()`; and `ps` showing nothing left after each end. It installs the managed browser engine into the temp root with `install-browser` (network) and drives a real engine and Chrome as a fixture bot over MCP with the bot's own bearer, without a model turn. Every launch gets `HOME` set to a short temp directory (the engine keeps Chrome, sockets and session state under `$HOME/.agent-browser`) and `CLAUDEBOT_DESKTOP_LOGIN_ITEM_FILE`, so no login item is registered. The tray is read from the main process (`process.mainModule.exports.desktop`) and its menu items are invoked by calling their `click` handlers; the menu bar itself is not clicked. It runs a fake Claude CLI after the first launch and never touches the real sign-in.
- `bun run smoke:desktop:profiles [app]` (macOS only, needs `package:desktop` first) drives the packaged `.app` the same way (shared helpers in `scripts/desktop-smoke-kit.ts`, including the temp `HOME` and the login-item file seam) against fixtures, not a real server: a second compiled host on loopback as the "remote", a host-info fixture for the API mismatch, a self-signed `https` fixture for the certificate error. It checks Add through the Connections window, the tray's connection items, the local host stopping and restarting with local and with a remote shown, the encrypted token in `profiles.json`, Connect, the navigation and OAuth policy on the new origin, Forget with revoke, the refused URLs, and startup on a saved active profile with and without its host.

Connection profiles (`profiles.json` in the user-data folder; `connections.ts`, `profile-store.ts`): the built-in profile `local` is the sidecar and is never stored. A remote profile holds a name, an origin, the device id and the device token encrypted with `safeStorage`; it is refused when encryption is unavailable or, on Linux, the backend is `basic_text`, never stored in plaintext. A profile URL is a bare origin, `https:` except `http:` for loopback hosts, so a plain-HTTP private network (Tailscale with `--allow-plain-http`) is refused. Every request to a host goes through the default session's `net.fetch`, so Chromium's certificate checks apply and nothing bypasses TLS; mutating requests send the profile's `Origin` (ADR 0005) and no cookies. Add and every connect first read `/api/host-info` and compare `apiVersion` with `SUPPORTED_API` in `host-api.ts`. The Connections window is served from the privileged scheme `claudebot-desktop:` in an in-memory session partition (`connections-page.ts`, `connections-window.ts`), with no preload and its navigation pinned to that scheme; its forms post to the scheme and get a 303 carrying only a message id. The local profile is the supervisor's current sidecar, read at every use: when the host restarts, `localChanged()` signs in again with the new token and reloads if `local` is shown, and while the host is starting or stopped `local` shows DESK-03's starting and "host is not running" pages (a remote profile keeps working then). The tray and the application menu's Connections submenu share `connectionItems` (`connection-items.ts`); `setupConnections` (`desktop-connections.ts`) gives `main.ts` `list()`, `connect(id)`, `openConnections()`, `start()`, `localChanged()` and `onChange()`.

## Deploy kit

`deploy/` holds the kit that installs the host on a systemd Linux server (`install.sh`, `claudebot.service`, `Caddyfile`). `deploy/README.md` is the self-hoster's guide; keep it in step with the unit, the installer and `platform/config.ts`. The kit has no permanent tests. Check it with `systemd-analyze verify deploy/claudebot.service` (Linux only), `shellcheck deploy/install.sh` and `caddy validate --config deploy/Caddyfile --adapter caddyfile`. The real-server run is ticket 04 of spec 5.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
