# Host package (`packages/host`)

Module layering rules live in `.dependency-cruiser.cjs` and `docs/adr/0003-feature-modules-and-dependency-rules.md`.

## Testing and fakes

- Prefer whole-host tests via `startHandoffHost` over mocking internals.
- **Fake Claude CLI** (`src/testing/fake-claude.ts`): reads `loop.json` (`host.loopScript(...)`), `plan-usage.json`, `invalid-token`, and `oauth.json` (see file header for all steps). A `loop.json` `match` is a substring of the entire message including the appended `<work_state>` block—use distinctive match strings.
- **Fake Telegram** (`src/testing/fake-telegram.ts`): loopback Bot API with real long-polling. Never pass a real-looking token; use `123:fake-token`.
- **Fake Google** (`src/testing/fake-google.ts`): point `HostServerOptions.google` at it; never aim tests at real Google endpoints.
- **Update helper tests** (`src/testing/update-world.ts`): run in temp roots with faked `systemctl`/`runuser`; nothing runs as real root in unit tests.

## Claude access and credentials

- `BILLING_ENV` (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`) is stripped from every CLI child in both local and remote modes (`src/harness/claude-access.ts`). The custom provider is the only deliberate API-billing path.
- Credentials pass over pipe/socket file descriptors (`CREDENTIAL_FD` = 3 via `ClaudeAccess.spawnSpec()`), never in `env` and never in regular files (which `/proc/<pid>/fd/N` can reopen when sandboxed off; see `docs/probe-credential-fd.md`).
- `claude.startGate()` serializes CLI startups and sign-in probes host-wide. Always read `spawnSpec()` inside the gate, and never call `startGate()` from inside a start (deadlocks).
- `claude auth status` reports signed in for any string on `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, so the host enforces the `sk-ant-oat01-` shape (`ClaudeLongLivedToken`) and persists rejected token SHA-256 digests (`claude-long-lived-token-rejected`).
- Bot sessions launch isolated: `settingSources: []` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
- Re-run `bun run probe:credential-fd` (real CLI) and `bun run eval:loop-routing` (ask first—uses the user's real Claude sign-in) whenever bumping the managed CLI version in `src/harness/cli.ts`.

## Security and persistence invariants

- **Database**: `PRAGMA user_version` (`SCHEMA_VERSION` in `src/platform/db.ts`). Opening a DB newer than the binary exits 2 (`DatabaseTooNew`) before writing anything.
- **File uploads**: `POST /api/files/upload` is the single raw `application/octet-stream` exception in `boundary.ts`, streamed via `wx` with per-segment symlink checks (`src/bots/upload.ts`). Keep it streaming-only; do not add JSON or base64 upload routes.
- **Built-in Gmail** (ADR-0012): never log mail content (operation names, status codes, and message IDs only). `send_message` is permanently locked (`Ask` or `Off`, never `Auto`; draft sends verify the draft did not change after approval). `builtinServers` stay in-process and must never be written into JSON `--mcp-config`.
- **Bot creation**: `mcp__bots__create_bot` is in `ALWAYS_ASK_TOOLS` (`src/waits/index.ts`): never offers `allow_always` and is denied immediately when unattended.
- **Root update helper** (ADR-0014): `src/update-helper/` (runs as root) and `src/upkeep/` may import only `platform/` and `@tomte/contract`.

## Host binary and sidecar

- `bun run build:host [target…]` embeds the built web UI and compiles `src/main.ts` to `dist/host/tomte-host-<os>-<arch>[.exe]`.
- `bun run smoke:host [binary]` runs a real compiled binary for the current OS (needs network unless `CLAUDE_PATH` is set).
- `--sidecar` (local mode only): reads one launch-token line from stdin, writes one `SidecarReady` JSON line to stdout (all human-readable logs go to stderr), and shuts down on stdin EOF.
- Format user-facing CLI commands through `src/platform/launch.ts` (`hostCommand`, `serverCommand`) so messages match source vs compiled binary execution.
- Remote mode is Linux-only (ADR-0006).
