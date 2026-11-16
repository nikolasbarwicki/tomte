# Plan: rebase the release epic onto master

Branch: `feat/release-rebase` (created at `feat/release` 9550c79). Target base: local `master` fcf4540.
`feat/release` itself stays untouched as the backup; do not move or delete it.

## Why

`feat/release` forked from master at 8721430. Since then master gained: 9a4353e (ship browser engine + Chrome inside the app),
f811477 (delete bot from sidebar), f9e5fab (remove herdr/omp integrations and the in-app Updates feature),
c94a1b4 (TickTick), ff4c407 (sonnet/medium defaults), fcf4540 (external events, answers, claudebot-notify, Herdr relay).
A trial merge conflicts in `AGENTS.md`, `packages/desktop/src/main.ts`, `scripts/package-desktop.ts`.

## Release commits to carry (oldest first, merges dropped)

6d75bb1 unsigned installers + update metadata (electron-builder) · d4f8861 tag-triggered host-binaries workflow ·
305c396 publish desktop installers with the release · 5e7e1a8 install.sh downloads host binary from a Release ·
71846d1 auto-update via electron-updater · 473eb8e signing/notarization plumbing · 19bc8ef update-fixture bundle id ·
f243328 verify-release · 17fc73b build every packaged arch's host · c7d9690 opt-in local signing route ·
978b193 drop stale DMG blockmap · ebbbc7b asc notarization backend.

## Ticket

01 rebase release onto master — one Sonnet worker in this worktree:
`git rebase master` (linear, keep each commit's message and authorship; resolve conflicts commit by commit).

Resolution rules:

- Keep both sides. Master's packaging must still bundle the browser engine/Chrome (9a4353e) and the release
  packaging (electron-builder installers, per-arch host builds, update metadata) must still work.
- f9e5fab removed an in-app "Updates" feature. Electron auto-update (71846d1) is a different mechanism; keep it,
  but if anything in the release commits re-adds code that f9e5fab deliberately removed (herdr/omp integration,
  the Updates UI/notices), do NOT re-add it: raise a `question` with the exact files/hunks and a recommendation.
- `AGENTS.md`: union of both sides' guidance, no duplicate sections.
- No behavior changes beyond what conflict resolution needs. Fix follow-on type/test breakages in a separate
  final commit "fix(release): adapt release epic to current master" if needed.

## Gate

- `bun run check` green (master baseline: 980 tests, 0 fail, ~94.7% lines / ~91.9% functions; coverage must not drop below the repo threshold).
- Release unit tests (`scripts/release-kit.test.ts` etc.) pass as part of check.
- A local unsigned packaging dry run if the scripts support one without signing (e.g. the unsigned installer path) — run in an
  isolated temp output dir, refuse if a Claudebot app is running, never invoke the local signing/notarization route.
- `git range-diff 8721430..feat/release master..feat/release-rebase` reviewed; report anything that changed meaning.

## Done

Report the new commit list, gate numbers, conflicts and how each was resolved, and any range-diff surprises.
Do not merge into master, push, tag or release.
