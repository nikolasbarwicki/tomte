# Desktop package (`packages/desktop`)

## Architecture boundaries

- Main process imports only `@tomte/contract` (enforced by `depcheck` rule `desktop-only-to-contract`, ADR-0003). Never import host code.
- Browser windows run with `contextIsolation: true`, `sandbox: true`, no Node, and no preload. Navigation is pinned to the active host origin; external URLs and `window.open` go to the system browser or are denied (`src/navigation-policy.ts`).
- Remote connection tokens require OS `safeStorage` (refused if unavailable or Linux `basic_text`; never stored plaintext). Profile URLs must be bare `https:` origins (`http:` allowed only for loopback).

## Window chrome (macOS)

- Main window uses hidden title bar + Window Controls Overlay (`src/window-chrome.ts`, `TITLE_BAR_HEIGHT = 56`).
- `56` equals web's `8px` inset + `40px` `AppBar` + `8px` so macOS traffic lights align with the header center line. Change desktop `TITLE_BAR_HEIGHT` and web's inset/`AppBar` together.
- The Connections window keeps the standard OS title bar.

## Packaging and auto-update

- `bun run build:desktop` bundles the main process to `dist/main.cjs`.
- `bun run package:desktop [--out <dir>] [--version <semver>] [--arch <arm64|x64>] [--host-dir <dir>] [--sign] [--update-url <loopback-http>]` packages for the current OS only.
  - Refuses to build/delete if a running process's command line is under the output folder (`scripts/process-guard.ts`); use `--out` to build alongside a running app.
  - Unsigned unless `--sign` or `TOMTE_REQUIRE_SIGNING=true`. In CI, fails if `GITHUB_REPOSITORY` is unset so the `.invalid` placeholder never ships.
  - Bundled browser (`Resources/browser-engine`) is cached in `dist/browser-cache/`.
- Auto-update (`electron-updater`) always uses metadata channel `latest` (`CHANNEL` in `scripts/desktop-kit.ts`), including for pre-releases. Updates always install through `before-quit` so the sidecar stops cleanly before files are replaced.

## Testing and macOS smokes

- Always set `TOMTE_DESKTOP_LOGIN_ITEM_FILE` in tests and smokes so nothing registers with OS login items.
- `scripts/desktop-smoke-kit.ts` sets `TOMTE_DESKTOP_UPDATES=off` and `TOMTE_DESKTOP_LOCAL_HOST_QUESTION=off` by default, and refuses to start if a process already runs from the target `.app` bundle.
- macOS smokes (run `bun run package:desktop` first):
  - `bun run smoke:desktop [app]`
  - `bun run smoke:desktop:profiles [app]`
  - `bun run smoke:desktop:titlebar [app]` (needs Accessibility permission for the terminal; logs/screenshots go to `.scratch/titlebar/`)
  - `bun run smoke:desktop:update <old.app> <feed-folder>` (requires fixture bundle id `dev.tomte.desktop.updatefixture` via `--update-url` so production `~/Library/Caches/dev.tomte.desktop.ShipIt` is never touched)
- To smoke a `.dmg` instead of the unpacked app: mount with `hdiutil attach -nobrowse -readonly`, `ditto` `Tomte.app` to a temp dir, detach, and pass the copied `.app`.
