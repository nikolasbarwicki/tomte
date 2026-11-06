## Checks

`bun run check` is the full gate; run it before calling work done. It runs, in order and stopping at the first failure: `fmt:check` (oxfmt), `lint` (oxlint, type-aware), `knip` (dead files, exports and dependencies), `typecheck` (tsgo, per package), `depcheck` (dependency-cruiser, ADR 0003 layering) and `test` (`bun test`). Each is also a script of its own. `bun run fmt` rewrites formatting in place.

### Git hooks

Git hooks come from lefthook (`lefthook.yml`) and are installed by `bun install` via the `prepare` script; it skips quietly outside a git checkout.

- pre-commit (staged files, parallel): `oxfmt --check`, `oxlint`, `gitleaks git --staged`. A format failure means run `bun run fmt` and re-stage.
- pre-push: `bun run check`.
- Prerequisite: [`gitleaks`](https://github.com/gitleaks/gitleaks) is a Go binary, not an npm dependency. Install it yourself (`brew install gitleaks` on macOS); pre-commit fails with an install hint when it is missing.

### CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`/`master`. Jobs: `check` (`bun install --frozen-lockfile`, then `bun run check`), `secrets` (gitleaks over the full history, config in `.gitleaks.toml`) and `audit` (`bun audit`, non-blocking until it exits 0; then drop `continue-on-error` in the workflow). The Bun version comes from `.bun-version`.

Branch protection is repo settings, not code. Once the repo is on GitHub, require the `check` and `secrets` jobs (replace `OWNER/REPO` and the branch):

```sh
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["check","secrets"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
