# TODO

Open items for the open-source launch and the first release, checked against the repository on
2026-11-20 (branch `open-source-launch`). Tickets: `.scratch/open-source-launch/issues/`.

## Local dry run (docs/release/local-release.md)

- [ ] Run `dist/rel-local-1/run-me.sh` (owner, own terminal, `CI` unset): sign-local run, partial
      release folder, `sign --key-file`, `verify-release --only darwin-arm64`, spctl, stapler.
- [ ] `bun run smoke:desktop` on the signed app (proves host, engine and Chrome under the hardened
      runtime; never run on a signed bundle).
- [ ] Install a signed app in `/Applications` (now an unsigned, ad-hoc local 0.1.0 build of b83745d).
- [ ] The darwin-x64 host of a local run stays unsigned (`sign-local` is arm64-only).

## Before the first release

- [ ] `gh secret set RELEASE_SIGNING_KEY` with the private half of the pinned key (pinned in
      `deploy/install.sh`; the repository has no secrets yet). `verify` fails without it.
- [ ] The five macOS signing secrets (Developer ID `.p12` and its password, the App Store Connect
      key, its id and issuer; names in AGENTS.md, Signing and notarization).
- [ ] Windows: decide PFX vs cloud signing (new certificates need a hardware key) before buying;
      until then Windows installers ship unsigned (SmartScreen warns).
- [ ] Windows packaging will likely hang: electron-builder converts `brand/app-icon.png` to `.ico`
      with its icon tool under `process.execPath` (Bun), which never exits. macOS was fixed by
      staging an `.icns` (`icnsFromPng`, b83745d); Windows needs an `.ico` the same way.
- [ ] After one signed release passes: `gh variable set TOMTE_REQUIRE_SIGNING --body true`.
- [ ] Merge `open-source-launch` into master and push (master is 7 commits ahead of origin, the
      branch 32; pre-push runs `bun run check`). The last master CI run (2026-11-18) failed: fix it.
- [ ] Release notes: hosts that relied on `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` now show
      as signed out (CHANGELOG [Unreleased]).
- [ ] First pre-release tag (`v0.1.0-rc.1`, `VERSION` to match), watch `Release`, then
      `verify-release` on the download. The Windows and Linux installers have never been built.
- [ ] Decide stable installer asset names so `releases/latest/download/<file>` works (README
      `TODO(release)`; names carry the version today).
- [ ] Decide the release-candidate feed: RC hosts see no update until a newer stable exists.
- [ ] Run `deploy/install.sh` from a real release on a real Linux host; reinstall the VPS from it so
      it gets the update helper (it runs an unmanaged `--url` build of `d15e53d`, schema 30; backup
      in `/var/backups/tomte/20261120-pre-oss-launch/`).

## Going public (ticket 01.5, 02, 03; GitHub refuses these while private)

- [ ] Flip the repository to public.
- [ ] Secret scanning with push protection, private vulnerability reporting, rulesets on master;
      then rewrite the CI paragraph of AGENTS.md (it says protection is unavailable).
- [ ] Discussion categories (Q&A, Ideas, Show and tell, Announcements) and the pinned "Start here".
- [ ] Upload `.github/assets/social-preview.png`; check the banner in both themes on GitHub.
- [ ] Link `docs/roadmap.md` items to issues.
- [ ] 2.5 acceptance: one recorded, unattended agent install from `INSTALL.md` on a fresh VM.
- [ ] 2.3: a browser takeover screenshot (the fake engine cannot show one).
- [ ] 4.1 acceptance: a browser-downloaded dmg opens with no Gatekeeper dialog on a clean Mac;
      only then drop the README's "unsigned" warning.

## After the first release (tickets 04.2 to 06, not started)

- [ ] 4.2 provenance attestations, SBOM, CodeQL, OpenSSF Scorecard, actions pinned by SHA.
- [ ] 4.3 `docs/privacy.md`: every network endpoint, where data lives, no telemetry.
- [ ] 4.4 Homebrew tap, winget, Docker image on GHCR, optional Nix flake.
- [ ] 4.5 `tomte-host doctor`.
- [ ] 05 docs site, docs CI, llms.txt, translated README; 06 demo mode, templates, launch.
- [ ] Uninstall has no command; Windows and Linux data paths are undocumented.

## Not yet proven for real

- [ ] Gmail: refresh token still valid after 7 days "In production"; record ticket 03 in ADR 0012's
      Evaluation; Gmail with the keychain secrets backend.
- [ ] A turn with a valid long-lived token (`sk-ant-oat01…`); gateway mode, the API-key descriptor
      and a real Claude CLI token refresh.
- [ ] A real snapshot restore through the update helper (systemd credentials work on the VPS).
- [ ] Local unsandboxed bots still inherit the provider token; decide whether to close that.

## Housekeeping

- [ ] Revoke the VPS setup token used for the ticket 16 check.
- [ ] Ticket 19: triage the sidecar "closing stdin stops a Claude CLI child" flake.
- [ ] Remove merged worktrees and branches (`feat/gmail-native`, `feat/client-host-split`, the
      `master-merge` worktree, `backup/master-pre-rewrite`); stop the dev server on port 5173.
- [ ] Decide on `feat/keychain-store` (tip 4c1d9a4, no local branch) and keychain tickets 04 and 05.
