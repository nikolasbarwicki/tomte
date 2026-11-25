# Contributing to Tomte

Thanks for helping. This file takes you from a fresh clone to a merged pull request. If something here is wrong or missing, that is a bug: open an issue or fix it in your PR.

## Pick something to work on

- Issues labelled [`good first issue`](https://github.com/nikolasbarwicki/tomte/labels/good%20first%20issue) are small and say which files to touch and how to check the result. [`help wanted`](https://github.com/nikolasbarwicki/tomte/labels/help%20wanted) are bigger and need someone with a setup the maintainer lacks (a Windows or Linux machine, another language).
- For a bug fix or a small improvement, open a PR directly; link the issue if there is one.
- For anything larger (a new feature, a new dependency, a change to how the host, the desktop app or the channels work), start a [Discussion](https://github.com/nikolasbarwicki/tomte/discussions) or an issue first. A design agreed before the code saves you a rewrite.
- Security problems never go in a public issue: use [private vulnerability reporting](https://github.com/nikolasbarwicki/tomte/security/advisories/new).

## Set up

You need:

- [Bun](https://bun.sh), the version in [`.bun-version`](.bun-version). CI uses exactly that one.
- [gitleaks](https://github.com/gitleaks/gitleaks), a Go binary the pre-commit hook runs (`brew install gitleaks` on macOS; a release binary elsewhere). Without it every commit fails with an install hint.
- Google Chrome, only for the browser smokes (below). `bun run check` does not need it.

```sh
git clone https://github.com/nikolasbarwicki/tomte.git
cd tomte
bun install        # also installs the git hooks (lefthook)
bun run check      # every gate; green on a fresh clone
```

Or skip the local setup: [`.devcontainer/`](.devcontainer/) has Bun, gitleaks and the Linux tools the tests need, and runs `bun install` on creation, so a GitHub Codespace or VS Code's Dev Containers can run `bun run check` straight away. It has no Chrome, so smokes still run on your own machine.

## Run it

```sh
bun run dev        # the host with the web UI through Vite, on http://127.0.0.1:5173
bun run host pair  # in a second terminal: prints a one-time code to enter in the browser
```

The host keeps its data (bots, database, workspace) in your user data folder (`~/Library/Application Support/tomte` on macOS, `$XDG_DATA_HOME/tomte` or `~/.local/share/tomte` on Linux, `%APPDATA%\tomte` on Windows). To keep development apart from a Tomte you use, set `TOMTE_DATA_ROOT` to another folder for both commands. [`.env.example`](.env.example) lists every variable the host reads.

Bots run on the Claude Code CLI with your own Claude sign-in. `bun run host install-cli` installs the CLI into the data root, and `bun run host auth-login` signs it in (or sign in from the Models page of the web UI).

### Without a Claude subscription

The test suite's fake Claude CLI also works for development. It answers every message with `ok`, never calls a model, and reports a signed-in account, which is enough for UI work:

```sh
mkdir -p /tmp/tomte-dev/fake
export CLAUDE_PATH="$PWD/packages/host/src/testing/fake-claude.ts"
export FAKE_CLAUDE_DIR=/tmp/tomte-dev/fake
export TOMTE_DATA_ROOT=/tmp/tomte-dev/data
bun run dev
```

Write another answer into `$FAKE_CLAUDE_DIR/result.txt` to change what it says. The header of `fake-claude.ts` lists every file that scripts it (approvals, questions, tool calls, a whole background-tasks session in `loop.json`). Anything that depends on what a real model does still needs the real CLI.

## Checks

`bun run check` is the gate: run it before you push (the pre-push hook does) and CI runs it on every pull request. It stops at the first failure, in this order:

| Step      | Script      | What fails it                                                                                                                     |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format    | `fmt:check` | oxfmt would change a file. `bun run fmt` fixes it.                                                                                |
| Lint      | `lint`      | oxlint, with type information.                                                                                                    |
| Dead code | `knip`      | An unused file, export or dependency. Delete it rather than exporting it.                                                         |
| Types     | `typecheck` | `tsc` in every package, then `scripts/`.                                                                                          |
| Layering  | `depcheck`  | dependency-cruiser: an import that crosses the module rules of [ADR-0003](docs/adr/0003-feature-modules-and-dependency-rules.md). |
| Tests     | `test`      | `bun test`, then the coverage gates.                                                                                              |

Tests always run with coverage, and two gates apply: a per-file floor (`coverageThreshold` in `bunfig.toml`) and a floor on the totals (`BASELINE` in `scripts/check-coverage.ts`). They only go up. If your change lowers coverage, add tests; never lower a number. When your tests raise the totals, raise `BASELINE` to the new value rounded down.

The hooks run on their own once `bun install` has installed them: pre-commit formats, lints and runs gitleaks on staged files, commit-msg checks the message, pre-push runs `bun run check`. Do not skip them with `--no-verify`.

### Browser smokes

Some flows are checked end to end in headless Chrome against the built web UI and the fake CLI. They are not in `bun run check`. Run `bun run smoke:ui` when you change the answer path, the relay, the background-tasks chat mode, the transcript's scrolling or the Channels page. [docs/smoke.md](docs/smoke.md) lists each smoke, what it covers and its prerequisites. A failed smoke keeps its run directory (screenshots, logs) and prints where it is.

The desktop smokes (`smoke:desktop*`) need a packaged macOS app; [packages/desktop/AGENTS.md](packages/desktop/AGENTS.md) describes them. You only need them when you change `packages/desktop/`.

## Conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org) (`feat(web): …`, `fix(host): …`, `docs: …`). The commit-msg hook and CI check it. Pull requests are squash-merged with the PR title as the commit message, so the title is what lands in history and in the release notes.
- **Layout.** `packages/host` is the server (Bun), `packages/web` the web UI (React), `packages/desktop` the Electron app, `packages/contract` the shapes they share, `packages/notify` the `tomte-notify` sender. Modules and what may import what: [ADR-0003](docs/adr/0003-feature-modules-and-dependency-rules.md) and [ADR-0004](docs/adr/0004-web-feature-modules-and-host-store.md).
- **Words.** [GLOSSARY.md](GLOSSARY.md) defines the domain terms (bot, routine, needs-you item, wait, front, report…). Use them in code, UI text and docs; add a term when you introduce one.
- **Decisions.** A choice that is hard to reverse or that a reader would question gets an ADR in [`docs/adr/`](docs/adr/), numbered after the last one. Read the ADRs of the area you change first; an accepted ADR is not reopened in passing.
- **Tests** check what a user of the code can observe, through the whole host where that is cheap (`startHandoffHost`, the fake CLI, the fake Telegram API). No test of a mock.
- **Docs** move with the code. When you change something AGENTS.md, a `docs/` page or `deploy/README.md` describes, update it in the same PR.

## Pull requests

1. Branch from `master`, keep the PR to one change, and fill in the template.
2. `bun run check` is green; the smokes your change touches pass.
3. UI changes include a screenshot or a short recording.
4. On your first PR a bot asks you to accept the [Contributor License Agreement](CLA.md); reply with the sentence it quotes. Why a CLA: [ADR-0013](docs/adr/0013-agpl-license-cla-and-reserved-name.md).

The maintainer reviews when they can; a PR that is green and small gets merged first.

## An agent-friendly repository

[AGENTS.md](AGENTS.md) is the entry point for coding agents (Claude Code, Codex, Cursor and the like): commands, repo-wide rules, and pointers to package-level `AGENTS.md` files (`packages/host/`, `packages/desktop/`, `packages/web/`) and `docs/`. `.agents/skills/` holds skills (prompted workflows) shared with agents working in this repo; `skills-lock.json` pins where each came from. Maintainer planning lives in `.scratch/`; public work is tracked in GitHub Issues.

AI-assisted pull requests are welcome on these terms:

- Say so in the PR template (which tool, roughly what it wrote).
- You have read and understood every line you submit, and you can answer review questions about it yourself.
- `bun run check` and the relevant smokes pass on your machine; a PR that has never been run is not ready.
- No unrelated churn: no reformatting, renamed variables or rewritten comments outside your change, and no new comments that restate the code.

PRs that ignore this may be closed without a detailed review.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
