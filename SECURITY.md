# Security policy

## Supported versions

Tomte is pre-1.0. Only the latest release receives security fixes. The desktop app updates itself; a server install updates by running the installer again ([deploy/README.md](deploy/README.md)).

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on [this repository](https://github.com/nikolasbarwicki/tomte/security/advisories/new). Do not open a public issue or Discussion for a vulnerability.

Include the version (Settings → About), the platform, what you did, what you expected and what happened. A proof of concept helps. Never include a real token, key or Claude sign-in; redact them.

Tomte has one maintainer. Targets, not guarantees: an acknowledgement within 3 days, a first assessment within 7 days, and a fix or a written plan within 30 days. You will be told when the advisory is published, and credited unless you prefer not to be.

## Scope

In scope: the host (`packages/host`), the web UI, the desktop app, channels (Telegram), the answer relay, the browser endpoint and the deploy kit (`deploy/`). The [threat model](docs/threat-model.md) lists what each part is meant to protect and the boundaries between them; a way across one of those boundaries is a vulnerability.

Examples that count:

- a web page, a bot or another local process reaching the client API, a device token, a bot's event token or a secret without the credential;
- a bot reading the Claude sign-in, the secrets store or another bot's folder through the sandbox;
- a tool that is meant to ask (`ALWAYS_ASK_TOOLS`, an `ask` policy) running without the owner's answer;
- a stranger's Telegram message reaching a bot, or a card's button answering for the wrong item.

Out of scope:

- anything that needs the owner's own account, device token or file access on the host: a person who can write the data root has already won;
- a bot doing what the owner approved, or what its tool policies allow;
- model behaviour in itself (a model following an injected instruction) when the host's approvals still held;
- vulnerabilities in Claude Code, Chrome, Electron, Bun or another dependency that Tomte only bundles: report those upstream, and tell us if Tomte needs to ship a fixed version;
- denial of service against your own machine, and missing hardening on a host you chose to expose without HTTPS.

## Handling

Fixes ship in a normal release with a GitHub Security Advisory, a CVE where one applies and a [CHANGELOG](CHANGELOG.md) entry. Secrets in the repository are scanned with gitleaks in CI and on every commit.
