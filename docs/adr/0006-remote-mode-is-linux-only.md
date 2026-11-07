# 0006: Remote mode is Linux-only

Status: accepted

## Context

Remote mode keeps the Claude sign-in away from bots. The host sets `CLAUDE_CONFIG_DIR` to `claude/` in the data root, and every bot's shell isolation (ADR-0001, "Note: shell isolation for every bot") denies reads of that directory. A bot cannot read the sign-in because the sign-in is a file in a path the sandbox denies.

That holds only where the Claude CLI stores its sign-in in a file. On macOS the CLI keeps it in the user's login keychain, even with `CLAUDE_CONFIG_DIR` set: with a different `HOME`, `auth-status` reports signed out, so the keychain, not the directory, holds the sign-in.

Bot shells run under Claude Code's sandbox. Its macOS Seatbelt profile (`@anthropic-ai/sandbox-runtime`) explicitly allows `mach-lookup` to `com.apple.SecurityServer` and `com.apple.securityd.xpc`, the services that answer keychain requests. The deny-read rules cover file paths only, so no rule stops a bot from asking the keychain for the sign-in. Denying the keychain directory (already on the list) does not help, because the request goes through those services, not through a file read.

A runtime probe, which would have shown whether a sandboxed bot can read the sign-in on macOS, was not run. Whether a bot can read it there is unverified; the profile's rules say it can ask.

## Decision

Remote mode is supported on Linux only. `parseHostConfig` throws `InvalidConfig` for `--mode remote` (or `CLAUDEBOT_MODE=remote`) on every platform except `linux`. On macOS the message names the keychain and says to use local mode on a Mac and run remote mode on a Linux server.

Windows is refused too. The remote target is a Linux server, and neither the spec nor the tests cover remote mode on Windows. Refusing every platform except Linux avoids claiming support that no one verified.

Local mode is unchanged on every platform.

On Linux the sign-in is a file under `<dataRoot>/claude`, which every bot's sandbox denies. This was verified with the built `linux-arm64` host in a Debian container. The real Claude CLI reported signed in once a synthetic `<dataRoot>/claude/.credentials.json` was in place, and signed out without it. The host passed the CLI a deny list naming that directory, `secrets.enc`, the key file, the database and the other bots' directories. The sandbox runtime's bubblewrap backend (`@anthropic-ai/sandbox-runtime` 0.0.81, bubblewrap 0.12.0) then hid all of them from a non-root shell while the bot's own files stayed readable. No real sign-in was used on Linux; the credential was a canary file.

The Linux sandbox needs unprivileged user namespaces. On Ubuntu 24.04, where `kernel.apparmor_restrict_unprivileged_userns=1` is the default, bubblewrap cannot set up its network namespace. A container also needs `/proc` unmasked and seccomp and AppArmor relaxed for bubblewrap. Without those the sandbox cannot start; the host launches remote bots with `failIfUnavailable`, which tells the CLI to refuse shell commands rather than run them unsandboxed (that path was not exercised).

## Alternatives considered

- **Probe the keychain from a sandboxed bot, then decide.** Rejected for now: the probe was not run. A negative result on one macOS release would not bind the next, and a positive one means the design fails anyway.
- **Keep remote mode on macOS and document the risk.** Rejected: a prompt-injected bot could take the user's Claude sign-in, which is the exact outcome remote mode's isolation exists to prevent.
- **Refuse only macOS.** Rejected: it would leave Windows accepted without a specification or a test.

## Consequences

- A Mac can run local mode only. Anyone who wants remote mode runs it on a Linux server.
- Remote-mode tests build their configuration with a Linux `HostSystem`, so they run on a Mac too. The evidence that the sign-in is out of a bot's reach comes from a Linux run (see Decision), not a macOS one.
- A Linux server must allow bubblewrap to create user namespaces (see Decision); deployment docs must say so.
- Revisit this decision if Claude Code gains file-based credentials on macOS, or if the sandbox profile denies `com.apple.SecurityServer` and `com.apple.securityd.xpc` to bot shells.
