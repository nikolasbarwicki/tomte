# 0015: The repository goes public with its existing history

Status: accepted. Ticket: `.scratch/open-source-launch/issues/01-go-public-gate.md`, part 1.1.

## Context

Everything in the history becomes public when the repository's visibility flips. Before the flip, on 2026-11-18, the repository was audited:

- `gitleaks git` over every branch (325 commits, including the local `backup/master-pre-rewrite`) found no leaks. `master` holds 55 commits.
- No absolute personal path (`/Users/<name>`) appears in any commit. The paths left in tests and placeholders (`/Users/ada`, `/Users/someone`, `<machine>.<tailnet>.ts.net`) are fictional.
- `.env`, `.scratch/`, `.host/`, `coverage/` and `dist/` are gitignored and have no tracked file.
- Every commit's author is the owner's personal email address.

## Options

- **History.** Publish the 55 commits as they are, or squash them into one fresh commit. Squashing hides the internal back-and-forth but loses blame and breaks commit references.
- **Author email.** Keep it, or rewrite every commit to a GitHub noreply address with `git filter-repo --mailmap`, which changes every SHA. The address is already on the owner's GitHub profile.
- **Internal docs.** Keep `docs/plans/` and `docs/research/` public, or untrack them. AGENTS.md and the ADRs cite them throughout.

## Decision

1. Publish the existing 55 commits; no squash.
2. Keep the author email; no rewrite. Later commits may use the GitHub noreply address.
3. Keep `docs/plans/` and `docs/research/` public, with two changes:
   - `docs/research/grok-bot-alternatives/` (competitor analysis) is untracked and kept outside the repository; the roadmap's references to it now say so.
   - The owner's email address in `docs/research/integrations-screen-research.md` is replaced with a description.
4. Never push `backup/master-pre-rewrite`, which holds the history from before an earlier rewrite; delete it before the flip.

## Consequences

- The removed competitor notes and the email line stay readable in earlier commits. They are not secrets; removing them from the current tree is a positioning choice, not a security fix. `.gitleaks.toml` keeps its allowlist entry for the old research path, because the CI secrets job scans the full history.
- Nothing needed rotating.
