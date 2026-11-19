# Credential probe

`scripts/probe-credential-fd.ts` answers one question with the real Claude CLI on a real Linux host: **can a bot's Bash read the credential the host hands the CLI?** It exists because remote-mode bots' shells are children of the CLI, and `.scratch/client-host-split/spec.md` (decision 7, open question 1) puts credentials on file descriptors only if a bot cannot read them. It is not part of `bun run check`: it needs the managed CLI, Linux, bubblewrap and `socat`.

No sign-in and no Anthropic traffic. A fake Anthropic Messages API on loopback answers the CLI's first request with a `tool_use` of `Bash` running `scripts/probe-credential-fd.sh`, and records the next request's `tool_result`. The credential is a canary (`canary-<32 hex>`, new each run, never real). The shell script recognises the canary by its shape, so the canary is never in the command, and redacts it from everything it prints. It looks in the shell's environment, `/proc/self/fd`, every descriptor of the shell read directly and through `/proc`, and the environment, descriptors and command line of every ancestor and every visible process.

A run only counts when the fake gateway received the canary as the CLI's own auth header (`canary reached the gateway as the CLI's own auth`). Otherwise the CLI never read it and "not visible" proves nothing; the probe then exits 1.

## Modes

| Mode                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host-env --host <binary> [--auth bearer\|api_key]` | The real host (a `build:host linux-x64` binary) in remote mode on a fresh data root: the canary is stored as the custom provider's token through `/api/providers/claude/gateway`, a bot is created and sent one message. The host's own spawn path, options, sandbox and environment; since ticket 16 the host hands the token to the CLI on descriptor 3 (`ClaudeAccess.spawnSpec()`), so this mode checks that path end to end. The long-lived token (`/api/providers/claude/token`) travels the same way.                                                                                                                                                                                                                                           |
| `fd-oauth`, `fd-gateway` `[--fd-kind pipe\|file]`   | The canary goes to the CLI on descriptor 3 named by `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` or `CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR` (`fd-gateway` also sets `CLAUDE_CODE_USE_GATEWAY=1`; the CLI ignores the descriptor without it). The host does this itself now (`host-env`); these modes isolate the mechanism: the probe opens the CLI through the SDK with the host's environment (`createClaudeAccess`) and launch options (`claudeHarness`, `browserIsolation`), and a spawn function that adds the descriptor. `pipe` is a socketpair written once and closed (what Node's `stdio: "pipe"` makes); `file` is an unlinked regular file at offset 0, the worst case for a bot that reopens it through `/proc`; the host never uses it. |
| `env-token`                                         | The canary in `ANTHROPIC_AUTH_TOKEN` in the CLI's environment, as the host did before it used descriptors, without the host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`fd-*` and `env-token` also take `--sandbox on|off` (default on; `off` runs the shell unsandboxed) and `--env NAME=VALUE` (repeatable, added to the CLI's environment). `env-token --sandbox off` is the positive control: it exits 0 only when the scan finds the canary, so a blind scan cannot pass for "not visible".

Exit status: 0 the canary was not visible to the shell (the control: it was), 3 it was visible, 1 the probe failed or proved nothing, 2 bad usage.

## Running it on a Linux server

The probe runs on the server, so compile it and the host for it on a developer machine:

```sh
bun run build:host linux-x64
bun build --compile --target=bun-linux-x64-baseline scripts/probe-credential-fd.ts --outfile dist/probe
scp dist/probe dist/host/tomte-host-linux-x64 server:/tmp/probe-dir/
```

On the server, as an ordinary user in one temporary directory, install the managed CLI (the only step that needs the network), then run every mode with no network at all so nothing can reach Anthropic:

```sh
cd /tmp/probe-dir && chmod +x probe tomte-host-linux-x64
export HOME="$PWD/home" && mkdir -p "$HOME"   # the CLI's sandbox leaves dotfile placeholders and caches in $HOME
./tomte-host-linux-x64 install-cli --data-root "$PWD/cli"
run() { bwrap --dev-bind / / --unshare-net --die-with-parent ./probe "$@" --data-root "$PWD/cli"; }
run env-token --sandbox off     # control: must report YES
run env-token
run host-env --host "$PWD/tomte-host-linux-x64" --auth bearer
run host-env --host "$PWD/tomte-host-linux-x64" --auth api_key
run fd-oauth --fd-kind pipe
run fd-gateway --fd-kind pipe
```

`--data-root` only names where the managed CLI is: each run starts on an empty data root of its own inside a temporary directory it removes. `PROBE_DEBUG=1` prints the fake gateway's requests and the CLI's stderr live; use it only with canaries. When done, remove the probe directory and what the CLI left outside it: `/tmp/claude-$(id -u)` and `/tmp/cc-socks`. Check with `ps` that no `claude`, `bwrap` or `probe` process of yours is left.

## Results

The latest recorded run is in `.scratch/client-host-split/spec.md` (Implementation reconciliation, ticket 15). Run it again when the managed CLI version in `harness/cli.ts` changes, and before relying on a descriptor for a credential.
