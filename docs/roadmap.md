# Roadmap

What is being worked on, what is next and what is not planned. Status of what exists today is in [features.md](features.md). Ideas and requests go in [Discussions](https://github.com/nikolasbarwicki/tomte/discussions); a roadmap item becomes an issue when someone starts it.

Dates are intentionally absent: Tomte has one maintainer.

## Now

- **First public release.** Stable installer names, a published release with checksums, and the download links in the README.
- **Signed macOS and Windows builds.** The pipeline exists ([AGENTS.md](../AGENTS.md#signing-and-notarization)); it needs certificates and a signed pre-release to prove it.
- **Docs and onboarding.** README screenshots generated from the test harness, a sourced comparison ([compare.md](compare.md)), an install guide an AI assistant can follow, a troubleshooting page.

## Next

- **Webhook triggers for routines**: a per-routine secret URL that starts a run with the request body as untrusted data. Needs a decision on how a laptop is reached (a documented tunnel recipe or a relay) and a dedupe key for repeated requests.
- **`tomte-host doctor`**: one command that reports the host version, data root, Claude CLI, browser engine, channels and recent errors, with secrets redacted.
- **Provenance and an SBOM** for release artifacts; a page listing every network connection Tomte makes.
- **Package managers**: Homebrew, winget, a Docker image.

## Later

- **A second harness** (Codex) behind the existing `Harness` interface, with per-bot choice and a fallback on a rate limit.
- **Bots exposed to other agents** over A2A or MCP; handoffs are already shaped like it.
- **Bot-authored skills.**
- **More channels** (Web Push, Slack, WhatsApp). The channel interface is transport-neutral ([ADR-0010](adr/0010-channels-deliver-needs-you-items.md)).

## Not planned

Hosted cloud offering, paid tiers, mobile apps, team workspaces and multiple owners per host.
