## Checks

`bun run check` is the full gate; run it before calling work done. It runs, in order and stopping at the first failure: `fmt:check` (oxfmt), `lint` (oxlint, type-aware), `knip` (dead files, exports and dependencies), `typecheck` (tsgo, per package), `depcheck` (dependency-cruiser, ADR 0003 layering) and `test` (`bun test`). Each is also a script of its own. `bun run fmt` rewrites formatting in place.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Checks

`bun run check` is the full gate (format, lint, knip, typecheck, depcheck, tests). Git hooks come from lefthook (`lefthook.yml`) and are installed by `bun install` via the `prepare` script; it skips quietly outside a git checkout.

- pre-commit (staged files, parallel): `oxfmt --check`, `oxlint`, `gitleaks git --staged`. A format failure means run `bun run fmt` and re-stage.
- pre-push: `bun run check`.
- Prerequisite: [`gitleaks`](https://github.com/gitleaks/gitleaks) is a Go binary, not an npm dependency. Install it yourself (`brew install gitleaks` on macOS); pre-commit fails with an install hint when it is missing.
