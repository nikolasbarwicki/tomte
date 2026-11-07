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

`main.ts` is the one compiled entry and also runs from source: `[flags] [botId]` starts the server like `bun run ui`; `pair`, `install-cli`, `install-browser`, `browser-smoke`, `auth-status` and `auth-login` run the `host.ts` subcommands; `credential-plugin <url>` is internal (the browser engine spawns the binary with it). Any message that names a command goes through `platform/launch.ts` (`hostCommand`, `serverCommand`), so it names the binary or `bun run host` depending on how the host was started.

`bun run smoke:host [binary]` (default: this machine's build output) runs a built binary for real: it copies it outside the repo, installs the managed Claude CLI with `install-cli` (unless `CLAUDE_PATH` names one), starts it on a temporary data root, pairs with `pair`, creates a bot, checks the event stream, loads the embedded UI (every asset `index.html` references, with the CSP), checks what the client listener refuses, stops it with SIGTERM and removes everything. It needs network for the CLI install and runs only a binary built for the machine it runs on (for a Linux binary in a container, compile the script with `bun build --compile --target=bun-linux-arm64 scripts/smoke-host.ts` and run both binaries there).

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
