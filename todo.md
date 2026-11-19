# TODO

Open items after the gmail-native (38feae2) and client-host-split (8c69879) squash merges.

## Before the first release

- [ ] Generate the Ed25519 release key: `gh secret set RELEASE_SIGNING_KEY`, then pin
      `RELEASE_PUBLIC_KEY` in `deploy/install.sh` (empty now). See `docs/release/signing.md`.
- [ ] Push master (pre-push runs `bun run check`), then confirm CI is green.
- [ ] Run the GitHub Actions release once and check the signed `SHA256SUMS` and `release.json`.
- [ ] Run `deploy/install.sh` on a real Linux host from a real release.
- [ ] Decide the release-candidate feed: RC hosts see no update until a newer stable exists.

## Gmail (ADR 0012)

- [ ] 7-day check: with the client "In production", confirm the refresh token still works after
      7 days.
- [ ] Record the ticket 03 results (owner-tested against real Google) in ADR 0012's Evaluation.
- [ ] Try Gmail against the real Claude CLI with the keychain secrets backend (tested only with
      the file backend so far).

## Client/host split, not yet proven for real

- [ ] A turn with a valid long-lived token (`sk-ant-oat01…`); the fd path itself is proven.
- [ ] Real systemd credentials and a real snapshot restore.
- [ ] Gateway mode, the API-key descriptor and a real Claude CLI token refresh.
- [ ] `bun run smoke:desktop` after the tray changes.
- [ ] Local unsandboxed bots still inherit the provider token; decide whether to close that.
- [ ] Hosts that relied on `ANTHROPIC_API_KEY` now show as signed out; note it in release notes.

## Housekeeping

- [ ] Revoke the VPS setup token used for the ticket 16 check.
- [ ] Ticket 19: triage the sidecar "closing stdin stops a Claude CLI child" flake.
- [ ] Run `bun install` after pulling master (new dependencies).
- [ ] Remove the merged worktrees and branches: `feat/gmail-native`, `feat/client-host-split`,
      the `master-merge` worktree; stop the gmail dev server on port 5173.

## Keychain (older branch)

- [ ] Recover or decide on `feat/keychain-store` (tip 4c1d9a4).
- [ ] Keychain tickets 04 and 05.
