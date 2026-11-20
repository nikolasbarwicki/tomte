# 0013: Tomte is AGPL-3.0-only with a Claude SDK exception, a CLA and a reserved name

Status: accepted. Ticket: `.scratch/open-source-launch/issues/01-go-public-gate.md`, part 1.2.

## Context

Tomte is going public as open source. The owner plans to earn from it later through a paid tier and a hosted subscription, and does not want others to resell the app as their own business.

No open source license (OSI definition) forbids commercial use or resale. Source-available licenses that do (FSL, BUSL, PolyForm) are not open source and are ruled out.

The host binary compiles in the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), whose `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." The Claude Code CLI is downloaded at install time and never distributed.

## Options

- **MIT or Apache-2.0.** Widest adoption; anyone may sell or host a closed fork.
- **AGPL-3.0.** Commercial use is allowed, but anyone who distributes Tomte or offers a modified Tomte over a network must publish their source under the AGPL. Many companies ban AGPL, which pushes them to buy a commercial license from the copyright holder.
- **Contribution terms.** DCO (contributors certify their right to submit; their code stays under the AGPL only) or a CLA (contributors license their code to the maintainer under any terms).
- **The proprietary SDK.** An AGPL program combined with a proprietary library cannot be conveyed under the AGPL's terms. Either grant an additional permission under AGPL section 7, or stop distributing the SDK in the binary and install it at runtime.

## Decision

1. **License: AGPL-3.0-only** (`LICENSE`, the unmodified text, so GitHub detects it). "Only", not "or later": the maintainer, not the FSF, decides whether a future version applies.
2. **Additional permission** (`NOTICE`): conveying Tomte combined with the Claude Agent SDK or the Claude Code CLI is allowed, and their source is not part of the Corresponding Source. They stay under Anthropic's terms.
3. **The SDK stays bundled** in the host binary, on the reading that Anthropic's terms allow products built on it. Re-check those terms, or install the SDK at runtime, before charging for Tomte.
4. **CLA** (`CLA.md`, accepted per pull request through `.github/workflows/cla.yml`, signatures on the `cla-signatures` branch). It licenses contributions to the maintainer under any terms, which a dual license or closed paid features need.
5. **Reserved name** (`TRADEMARKS.md`): the name and logo are not licensed by the AGPL; forks must rename.
6. Every `package.json` says `"license": "SEE LICENSE IN …/LICENSE"`, since AGPL plus a custom exception has no SPDX identifier.

## Consequences

- A hosted or redistributed fork must publish its source and use another name; selling it is still allowed.
- Companies that avoid AGPL will either not use Tomte or buy a commercial license; that is the intended path to revenue.
- External pull requests need a CLA signature before merge, a small friction for contributors.
- Paid features can live in a private repository or under a separate license; both stay possible.
- Third-party license texts ship with every distribution (`licenses/`, generated at build time).
- Open risk: running a hosted service on users' Claude subscriptions, and redistributing the SDK, depend on Anthropic's terms, which this ADR does not settle.
