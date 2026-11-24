# Roadmap

What is being worked on, what is next and what is not planned. Status of what exists today is in [features.md](features.md). Ideas and requests go in [Discussions](https://github.com/nikolasbarwicki/tomte/discussions); a roadmap item becomes an issue when someone starts it.

Dates are intentionally absent: Tomte has one maintainer.

## Now

- **First public release.** A published release with signed checksums, then stable installer names so the README can link each installer. The Windows and Linux installers have never been run: [#16](https://github.com/nikolasbarwicki/tomte/issues/16), [#17](https://github.com/nikolasbarwicki/tomte/issues/17).
- **Signed macOS and Windows builds.** The pipeline exists ([AGENTS.md](../AGENTS.md#signing-and-notarization)); it needs certificates and a signed pre-release to prove it.
- **Onboarding checked for real.** One recorded install by an AI assistant following [INSTALL.md](../INSTALL.md) on a fresh machine, and a screenshot of a browser takeover.

## Next

- **Webhook triggers for routines**: a per-routine secret URL that starts a run with the request body as untrusted data. Needs a decision on how a laptop is reached (a documented tunnel recipe or a relay) and a dedupe key for repeated requests.
- **`tomte-host doctor`**: one command that reports the host version, data root, Claude CLI, browser engine, channels and recent errors, with secrets redacted.
- **Provenance and an SBOM** for release artifacts, CodeQL and an OpenSSF Scorecard. The page listing every network connection exists: [privacy.md](privacy.md).
- **Package managers**: a Homebrew cask ([#19](https://github.com/nikolasbarwicki/tomte/issues/19)), winget, Scoop, AUR or Nix ([#20](https://github.com/nikolasbarwicki/tomte/issues/20)), a Docker image.
- **Translations** of the web UI and the README ([#18](https://github.com/nikolasbarwicki/tomte/issues/18)).
- **An uninstall command**; today the [README](../README.md#uninstall) lists the folders to delete on each platform.

## Later

- **A second harness** (Codex) behind the existing `Harness` interface, with per-bot choice and a fallback on a rate limit.
- **Bots exposed to other agents** over A2A or MCP; handoffs are already shaped like it.
- **Bot-authored skills.**
- **More channels** (Web Push, Slack, WhatsApp). The channel interface is transport-neutral ([ADR-0010](adr/0010-channels-deliver-needs-you-items.md)).

## Not planned

Hosted cloud offering, paid tiers, mobile apps, team workspaces and multiple owners per host.
