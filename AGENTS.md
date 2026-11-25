# Tomte

Definition of done: `bun run check` passes, plus relevant smokes when touching UI, desktop, or host-binary paths.

## Commands

- Install (also installs lefthook git hooks): `bun install`
- Dev server (host + Vite UI on `127.0.0.1:5173`): `bun run dev`
- Full gate (runs in order, stops on first failure): `bun run check`
- Individual gates: `bun run fmt:check` (`bun run fmt` fixes), `bun run lint`, `bun run knip`, `bun run typecheck`, `bun run depcheck`, `bun run test`
- Single test file: `bun test <path/to/file.test.ts>`
- Browser smokes (needs Chrome; outside `check`): `bun run smoke:ui`

## Non-standard rules and gotchas

- **Coverage floors never drop.** `bun test` always runs with coverage. Never lower `coverageThreshold` in `bunfig.toml` (Bun reads plural keys `lines`/`functions` only; singular keys are silently ignored) or `BASELINE` in `scripts/check-coverage.ts`. Add tests when coverage drops; raise the floors when coverage rises.
- **Git hooks are the real merge gate.** The private repo has no server-side branch protection. Never pass `--no-verify`. Pre-commit runs `oxfmt`, `oxlint`, and `gitleaks` (requires `brew install gitleaks` on macOS); `commit-msg` enforces Conventional Commits (`commitlint`); pre-push runs `bun run check`.
- **Stale docs.** When documentation and code disagree, follow the code and report or update every mismatch.
- **Expensive / real-model scripts.** Ask before running `bun run eval:loop-routing` (runs ~31 sessions on the user's real Claude sign-in; `--dry-run` is free).
- **Licensing.** AGPL-3.0-only (ADR-0013). Any new bundled non-npm component needs its license text in `licenses/<name>.txt` and an entry in `NOTICE`.
- **Deploy kit.** Keep `deploy/README.md` in sync with `deploy/install.sh`, `deploy/tomte.service`, and `packages/host/src/platform/config.ts`. Check changes with `shellcheck deploy/install.sh`, `caddy validate --config deploy/Caddyfile --adapter caddyfile`, and (Linux) `systemd-analyze verify deploy/tomte.service`.

## Where to read next

Read only the file matching the area you touch:

- **Host server, Claude CLI, fakes, Gmail, uploads, update helper, binary**: [`packages/host/AGENTS.md`](packages/host/AGENTS.md)
- **Electron desktop app, WCO title bar, packaging, desktop smokes**: [`packages/desktop/AGENTS.md`](packages/desktop/AGENTS.md)
- **Web UI, feature slots, WCO CSS, smoke selectors**: [`packages/web/AGENTS.md`](packages/web/AGENTS.md)
- **Domain terms and architectural decisions**: [`GLOSSARY.md`](GLOSSARY.md) and [`docs/adr/`](docs/adr/) (conventions in [`docs/agents/domain.md`](docs/agents/domain.md))
- **Local issues, specs, and triage labels**: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) and [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- **Browser and update-helper smokes**: [`docs/smoke.md`](docs/smoke.md)
- **Cutting, signing, or verifying a release**: [`docs/release/releasing.md`](docs/release/releasing.md)
