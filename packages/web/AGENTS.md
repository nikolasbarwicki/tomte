# Web package (`packages/web`)

## Module boundaries

- Feature modules (`features/*`) cannot import one another (ADR-0004, enforced by `depcheck`).
- Compose cross-feature UI via slots in `app/routes/` (e.g. `BotPanel` slots in `app/routes/bot.lazy.tsx`, Channels slot in `app/routes/settings.lazy.tsx`).
- Shared bot-panel section definitions and legacy URL upgrades (`?panel=settings&section=…`) live in `lib/bot-panel.ts`; keep section order fixed.

## Desktop integration (WCO)

- Electron's `display-mode: window-controls-overlay` media query is false, so `lib/window-controls-overlay.ts` reads `navigator.windowControlsOverlay` and sets `data-wco` on `<html>` to gate `-webkit-app-region: drag` in `tailwind.css`.
- Keep the `8px` sheet inset + `40px` `AppBar` (`components/page.tsx`) aligned with desktop's `TITLE_BAR_HEIGHT` (56).

## File uploads

- All uploads (Files section and composer attachments) go through `host/upload.ts` (`POST /api/files/upload` as `application/octet-stream`, 4 concurrent), checking `maxUploadBytes` from `/api/info` before sending.

## Smoke selectors and verification

- Browser smokes depend on these selectors—keep them intact:
  - `getByRole("navigation", { name: /panel$/ })` (activity rail)
  - `[data-panel-section]` (panel body)
  - `[data-testid="profile-button"]` (bot header profile trigger)
  - `data-needs-you`, `data-chief-of-staff`, `data-host-problem`
- Run `bun run smoke:ui` (requires Chrome; see `docs/smoke.md`) when changing the answer path, relay, background-tasks UI, transcript scrolling, Channels page, or file uploads.
