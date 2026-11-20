# Deploy tomte on a Linux server

This kit turns a fresh systemd Linux server into a running tomte host in remote mode. It covers the install script, HTTPS with Caddy, a private-network option with Tailscale, and the two first-run steps: pairing a device and signing in the Claude CLI.

Remote mode is Linux-only ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). A Mac or Windows machine runs local mode instead.

## What the kit sets up

| Part             | Where                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System user      | `tomte` (user and group), home `/var/lib/tomte`, shell `/usr/sbin/nologin`                                                                                                                                                                                                                               |
| Data root        | `/var/lib/tomte`, owner `tomte:tomte`, mode `0700`                                                                                                                                                                                                                                                       |
| Binary           | `/usr/local/bin/tomte-host`, `root:root`, mode `0755`                                                                                                                                                                                                                                                    |
| Settings         | `/etc/tomte/tomte.env`, `root:root`, mode `0644`. Non-secret only: `TOMTE_HOST`, `TOMTE_PORT`, `TOMTE_PUBLIC_URL`, `TOMTE_ALLOW_PLAIN_HTTP`, and, if you add it, `TOMTE_PAUSE_AFTER_ABSENCE_DAYS` ([below](#pause-routines-when-you-are-away)) and `TOMTE_MAX_UPLOAD_MIB` ([below](#upload-size-limit)). |
| Secrets key      | A systemd credential named `secrets-key`: 32 random bytes in `/etc/credstore.encrypted/tomte.secrets-key`, encrypted with `systemd-creds`                                                                                                                                                                |
| Unit             | `/etc/systemd/system/tomte.service`, enabled, `Restart=always`                                                                                                                                                                                                                                           |
| Update helper    | `/etc/tomte/update.conf` (`root:root`, mode `0644`) and the units `tomte-update.path` and `tomte-update.service`, enabled when the install came from a release ([below](#updating-from-the-web-ui))                                                                                                      |
| Claude CLI       | Installed by `tomte-host install-cli` into the data root                                                                                                                                                                                                                                                 |
| Browser engine   | Installed by `tomte-host install-browser` into the data root (x86_64 only, see below)                                                                                                                                                                                                                    |
| Sandbox packages | `bubblewrap` and `socat`, installed with `apt-get` or `dnf` when missing                                                                                                                                                                                                                                 |

The unit starts the host as `tomte` with fixed flags: `--mode remote --data-root /var/lib/tomte --secrets-key-file %d/secrets-key`. `%d` is the credentials directory systemd creates for the service, `/run/credentials/tomte.service`. The host reads the key from that file only. It never reads the key from the environment.

Supported targets are systemd Linux on x86_64 and aarch64. The kit was run on Ubuntu 24.04 arm64 in a disposable VM and checked on Debian 12 in containers only (see [Limits and what is verified](#limits-and-what-is-verified)). Chrome for Testing publishes no Linux ARM64 build, so `install-browser` fails on aarch64. The installer warns and continues. Use an x86_64 server if you want browser bots.

## Prerequisites

- A server with systemd, root access over SSH, and outbound internet access (the installer downloads the Claude CLI and the browser engine, and the host talks to Anthropic and to your integrations' providers).
- `curl`, `sha256sum`, `systemctl`, `systemd-run`, `journalctl`, `runuser`, `useradd`, `getent`, `install`, `mktemp` and `head`, plus `openssl` (3.0 or newer) and `base64` for a release install, which verifies the release signature. The installer stops before it changes anything when one is missing.
- A host binary for the server: either a [GitHub Release](#install-from-a-github-release) of this project (the default, the installer downloads and verifies it), or a `tomte-host-linux-x64` / `tomte-host-linux-arm64` that you built with `bun run build:host linux-x64` (or `linux-arm64`, output in `dist/host/`) and host yourself ([Install your own binary](#install-your-own-binary)).
- For HTTPS with Caddy: a domain name you control. For the Tailscale option: a tailnet.

### Ubuntu user namespaces

Bot shells and browser bots run under bubblewrap, and Chrome for Testing runs its own Chromium sandbox; both create unprivileged user namespaces. Ubuntu 24.04+ sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, which causes bubblewrap to fail with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` and Chrome to exit with `No usable sandbox!`.

When the bubblewrap sandbox cannot start, remote mode fails closed ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). The host refuses shell commands for every bot, and browser bots are unavailable. Nothing runs unsandboxed. Debian 12 allows unprivileged user namespaces by default, so it needs nothing here.

The installer never changes the sysctl and never installs an AppArmor profile for the system `bwrap` binary: it detects the problem, warns, and finishes. For tomte's own managed Chrome binary (`$DATA_ROOT/.agent-browser/browsers/*/chrome`), the installer installs its missing shared libraries (`libatk`, `libcups2`, `libasound2`, `libgbm1`, `libcairo2`, `libpango`, X11/atspi) and, when `kernel.apparmor_restrict_unprivileged_userns=1` and `apparmor_parser` are present, writes and loads `/etc/apparmor.d/tomte-chrome` scoped only to that binary. For `bwrap`, you have two options.

**Option 1, preferred: an AppArmor profile that grants `userns` to `/usr/bin/bwrap` only.** Only bubblewrap regains user namespaces. Create `/etc/apparmor.d/bwrap`:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
```

Load it:

```sh
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

The profile survives a reboot. Re-run the installer afterwards. Its sandbox check should now pass. (The installer writes the matching `/etc/apparmor.d/tomte-chrome` profile for `/var/lib/tomte/.agent-browser/browsers/*/chrome` automatically when `apparmor_parser` is available.)

**Option 2: turn the restriction off for the whole system.**

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-tomte-userns.conf
sudo sysctl --system
```

This is weaker. Every program on the server regains unprivileged user namespaces, which is the attack surface Ubuntu closed on purpose. This option has not been tested with the kit. Prefer the profile.

## Run the installer

### Install from a GitHub Release

A release publishes the five host binaries, `SHA256SUMS` (the checksum of every other file, `release.json` included), `SHA256SUMS.sig` (its Ed25519 signature), `release.json` (the version, shell API range and database schema version), `install.sh` and `tomte.service`. The `install.sh` attached to a release already knows its repository. Download it on the server, read it, and run it as root:

```sh
curl -fsSLO https://github.com/<owner>/<repo>/releases/latest/download/install.sh
sudo bash install.sh --public-url https://tomte.example.com
```

Without `--url`, the installer picks the binary for the server's CPU (`x86_64` becomes `linux-x64`, `aarch64` becomes `linux-arm64`, anything else is refused) and downloads `SHA256SUMS`, its Ed25519 signature `SHA256SUMS.sig`, `release.json` and the binary from the release over HTTPS (a redirect to plain HTTP is refused). It verifies the signature against the release public key pinned in the script itself (`RELEASE_PUBLIC_KEY`, with `openssl`, so OpenSSL 3 or newer is required), then checks `release.json` and the binary against the signed `SHA256SUMS`. It aborts before it changes anything when the signature is invalid, a checksum differs, an entry is missing or the download fails. A script that sits alone, as above, also downloads `tomte.service` from the same release and checks it the same way. A script run from a checkout of this repository uses the `tomte.service` next to it.

The key is part of the script you read and run, not something the download supplies, so a compromised download channel cannot pass off its own `SHA256SUMS`. The copy of `install.sh` in the source tree has no key pinned yet and refuses to install from a release until the owner generates the key pair and pins the public key (`docs/release/signing.md`, "One-time setup"). A signature does not say which release is newest: pin the one you want with `--version`.

| Flag                  | Meaning                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--version <version>` | The release to install, such as `0.2.0` or `v0.2.0-rc.1`. Default: the latest release. Pins an install, and is how you go back to an older one.                                                                    |
| `--repo <OWNER/REPO>` | The GitHub repository whose releases to use. Also read from `TOMTE_REPO`. The release's `install.sh` has it filled in. The script in this source tree has none and refuses to guess, so a checkout needs `--repo`. |

GitHub's "latest release" never points at a pre-release. A tag such as `v0.2.0-rc.1` is a pre-release, so install it with `--version 0.2.0-rc.1`. Without `--version` the installer installs the newest release that is not a pre-release, and fails when there is none.

### Install your own binary

Use `--url` and `--sha256` for a binary you built or host yourself. They replace the GitHub download, so `--repo` and `--version` cannot be combined with them. Copy the `deploy/` directory of this repository and the binary to the server, so that `install.sh` and `tomte.service` sit side by side. Print the binary's SHA-256 on your build machine (`shasum -a 256` on a Mac, `sha256sum` on Linux):

```sh
scp -r deploy root@server:tomte-deploy
scp dist/host/tomte-host-linux-x64 root@server:
shasum -a 256 dist/host/tomte-host-linux-x64
```

Then run the installer on the server as root, with that SHA-256:

```sh
bash tomte-deploy/install.sh \
  --url file:///root/tomte-host-linux-x64 \
  --sha256 <hex> \
  --public-url https://tomte.example.com
```

### Flags

| Flag                    | Meaning                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url <URL>`           | Where the server downloads the binary: `https://`, `http://` or `file://`. `{target}` in the URL becomes `linux-x64` or `linux-arm64`. Needs `--sha256`. |
| `--sha256 <hex>`        | The expected SHA-256 of the download. On a mismatch the installer stops before it installs anything. Needs `--url`.                                      |
| `--public-url <origin>` | The origin users type into the browser, such as `https://tomte.example.com`. Written as `TOMTE_PUBLIC_URL`.                                              |
| `--host <addr>`         | The address the client listener binds. Default `127.0.0.1`. Written as `TOMTE_HOST`.                                                                     |
| `--port <n>`            | The port the client listener binds. Default `8417`. Written as `TOMTE_PORT`.                                                                             |
| `--allow-plain-http`    | Writes `TOMTE_ALLOW_PLAIN_HTTP=1`. For a non-loopback bind without an `https://` public URL, on private networks only.                                   |
| `--unit <path>`         | The unit to install. Default: `tomte.service` next to the script, else the release's.                                                                    |

`--repo`, `--version` and the download-source rules are above. `TOMTE_RELEASE_BASE_URL` (default `https://github.com`) changes where release files are fetched from, as `<base>/<owner>/<repo>/releases/...`. It exists for testing the installer against a local fixture and for GitHub Enterprise.

The host refuses to start when it binds a non-loopback address and the public URL is not `https://`, unless `TOMTE_ALLOW_PLAIN_HTTP=1` is set.

The installer creates the user and data root, writes the env file, creates the key, installs the binary, the Claude CLI and the browser engine, starts the unit, checks the sandbox, and prints a pairing code and the sign-in command. A failure of `install-cli` stops it. A failure of `install-browser` only warns.

### Re-run it safely

The installer is idempotent. A re-run keeps the existing env file and the existing key, and only warns when a flag differs from the env file (edit the file and restart the unit to change a value). It replaces the binary and the unit file with the ones you pass, restarts the service, and prints a new pairing code. Put local unit changes in a drop-in under `/etc/systemd/system/tomte.service.d/`, because a re-run overwrites `tomte.service`.

### What the sandbox check means

After the unit is active, the installer runs `bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc -- /bin/true` as `tomte` in a transient unit that carries every hardening directive of the installed unit. It also checks that `socat` exists.

If the check fails, the installer prints a warning that says bot shell commands and browser bots are unavailable, shows the check's output, and finishes anyway. On Ubuntu with the sysctl set to 1, the warning points at [Ubuntu user namespaces](#ubuntu-user-namespaces). A failed check does not stop the host. The host and its web UI run, but no bot runs a shell command.

`GET /api/host-info` reports `browserSandbox: true` whenever `bwrap` and `socat` are on the `PATH`, even when user namespaces are blocked. The installer's check is the real test, so trust it over the capability flag.

## Updating from the web UI

A host installed from a release can replace its own binary without the service user ever being able to write it ([ADR-0014](../docs/adr/0014-root-update-helper.md)). The host asks for an update by writing `/var/lib/tomte/updates/request.json`, a version number or "rollback" and nothing else. `tomte-update.path` sees the file and starts `tomte-update.service`, which runs `tomte-host apply-update` as root. It reads the repository and the release public key from `/etc/tomte/update.conf` (written by the installer from its own pinned key, root-owned, never from a download or from the request), downloads and verifies the release, keeps one previous binary as `/usr/local/bin/tomte-host.prev`, swaps the new one in, restarts `tomte` and requires 7 stable seconds of `is-active` plus `/api/host-info` reporting the new version. If that fails it puts the previous binary back, and the database snapshot taken before the update when there is one, and writes `/var/lib/tomte/updates/result.json` with the reason.

In the web UI, Settings, About, Updates offers **Update when idle** (new messages are refused with "Updating, back in a minute" and scheduled routines wait until running work has finished; after 30 minutes it keeps waiting and offers **Update now**), **Update now** (running work is interrupted and not run again) and **Cancel**. The host copies its database to `updates/pre-<version>.db` before it writes the request. A failed update shows a banner ("Update to 0.4.2 failed, rolled back to 0.4.1") on every page and sends one Telegram message. "Update automatically when idle" is off unless you turn it on.

After an update, Updates also offers **Roll back to <version>** (the one previous binary, kept as `/usr/local/bin/tomte-host.prev`) while that version can open the current database. If the update migrated the database, the previous version cannot, and the button is **Restore <version> and its database…** instead: it shows when `updates/pre-<version>.db` was taken, says that everything changed since is lost, and restores that copy only after you confirm. Rolling back drains like an update. The release you rolled back from is then skipped: it is not offered as an update and automatic updates do not install it (the setting itself is unchanged; the skip is the `skipped` version in `updates/upkeep.json`) until the feed names a newer release. Updates says so, and **Install <version> anyway** installs it explicitly. A failed rollback shows a banner ("Rollback to 0.4.1 failed") until dismissed.

Follow a run with `journalctl -u tomte-update.service`. A binary installed with `--url` has no release to update from, so the installer writes none of this and the host's updates are "unmanaged". `tomte-update.path` is level-triggered: if the helper fails before it consumes a request more than five times in ten seconds, systemd stops the path unit; `sudo systemctl reset-failed tomte-update.path tomte-update.service && sudo systemctl restart tomte-update.path` starts it again.

## HTTPS with Caddy

Caddy terminates TLS with automatic certificates and proxies to the host on loopback. The host keeps binding `127.0.0.1:8417`, and port 8417 stays closed to the network.

1. Point a DNS A record, and an AAAA record if the server has IPv6, at the server. Open ports 80 and 443 in your firewall, because Caddy uses them to obtain and renew the certificate.
2. Install Caddy from its official repository ([Caddy install instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)). The package runs Caddy as the `caddy` systemd service.
3. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and replace `tomte.example.com` with your domain.
4. Set the public URL in `/etc/tomte/tomte.env` to exactly `https://<your domain>`, with no trailing path:

   ```
   TOMTE_PUBLIC_URL=https://tomte.example.com
   ```

5. Restart both services:

   ```sh
   sudo systemctl restart tomte
   sudo systemctl reload caddy
   ```

The Caddyfile is one site block. It proxies to port 8417, so change the port in it if you set `TOMTE_PORT` to another value:

```
tomte.example.com {
	reverse_proxy 127.0.0.1:8417
}
```

Two details matter:

- **Host header.** The host answers 403 to any request whose `Host` header is not its own address or the public URL's host (a guard against DNS rebinding). It consults no `X-Forwarded-*` header. Caddy passes the original `Host` through by default, so leave it alone. A `TOMTE_PUBLIC_URL` that differs from the domain makes every request fail with 403 `bad host`.
- **Streaming.** The event stream and live view are server-sent events (`text/event-stream`). Caddy flushes those responses immediately, so the Caddyfile sets no `flush_interval` ([`reverse_proxy` streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)). The host serves no WebSocket to browsers.

If you passed `--public-url` to the installer on the first run, the env file already has the value.

## Private network with Tailscale

With Tailscale the host never faces the public internet. Install Tailscale on the server and on every device that uses tomte, and join them to one tailnet. Then pick one option.

### Option A: bind the tailnet address, plain HTTP

WireGuard encrypts the link between your devices and the server, so plain HTTP inside the tailnet is not readable by the network. Bind the client listener to the server's tailnet address (`tailscale ip -4` prints it) and tell the host that plain HTTP is intended. Set these in `/etc/tomte/tomte.env`:

```
TOMTE_HOST=100.x.y.z
TOMTE_PORT=8417
TOMTE_PUBLIC_URL=http://100.x.y.z:8417
TOMTE_ALLOW_PLAIN_HTTP=1
```

Then run `sudo systemctl restart tomte`. You can use the server's MagicDNS name in the public URL instead of the address, such as `http://myserver:8417`.

The host refuses a non-loopback bind unless the public URL is `https://` or `TOMTE_ALLOW_PLAIN_HTTP=1` is set, so the flag is required. Open tomte at exactly the public URL you set. The host accepts the `Host` header of that URL and of the bound address, and answers 403 to any other name for the same machine.

Tailscale must be up before the host starts, or the bind fails. The unit has `Restart=always` with a 5-second delay, so it recovers once Tailscale is up. This was reasoned from the unit, not tested.

### Option B: `tailscale serve` with Tailscale HTTPS certificates

The host stays on loopback and `tailscale serve` terminates TLS with a certificate for the machine's `<machine>.<tailnet>.ts.net` name.

1. In the Tailscale admin console, open the [DNS page](https://console.tailscale.com/admin/dns), enable MagicDNS, and under **HTTPS Certificates** select **Enable HTTPS** ([Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). Your machine name appears in the public Certificate Transparency ledger.
2. Proxy HTTPS port 443 to the host. Tailscale's `serve` documentation says only `http://127.0.0.1` is supported as a proxy target:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8417
   ```

   `--bg` keeps it running across reboots and `tailscale` restarts. [`tailscale serve` reference](https://tailscale.com/kb/1242/tailscale-serve) lists the flags. `tailscale serve status` shows the result and `tailscale serve --https=443 off` removes it.

3. Set the public URL in `/etc/tomte/tomte.env` to `https://<machine>.<tailnet>.ts.net` and run `sudo systemctl restart tomte`:

   ```
   TOMTE_PUBLIC_URL=https://myserver.tail1234.ts.net
   ```

`tailscale serve` forwards the original `Host` header to the backend (checked in Tailscale's source, `ipn/ipnlocal/serve.go`: `r.Out.Host = r.In.Host`), which the host's Host check needs. The `tailscale serve` command line itself was not run against a real tailnet for this kit.

### OAuth on a tailnet-only host

OAuth integrations work on a host that only your devices reach. The provider never connects to the host. The sign-in ends with a redirect of your browser to `<public URL>/oauth/callback`, so only your browser has to reach the public URL. The host contacts the provider's endpoints from the server, so the server needs outbound internet access.

The provider can still reject the redirect URL itself. Google, for example, requires an `https://` redirect URI, rejects a raw IP address as the host (localhost excepted), and requires a top-level domain in the public suffix list ([Google's redirect URI validation rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)). Therefore:

- Option A fails Google: `http://100.x.y.z:8417` is plain HTTP on a raw IP, and a bare MagicDNS name is plain HTTP too.
- Option B passes those rules: `https://<machine>.<tailnet>.ts.net` is HTTPS on a domain, and `ts.net` is in the [public suffix list](https://publicsuffix.org/list/public_suffix_list.dat). This kit did not complete a Google sign-in against it.
- Caddy with a public domain passes them.

A provider that registers clients dynamically may apply similar rules to the redirect URL it is given. If you need a provider that rejects your URL, use Caddy or Option B.

## Pair the first device

The installer prints a pairing code and says where to enter it. The code is 12 characters in groups of four. Open the public URL in a browser and enter it. A code is single-use and expires after 10 minutes ([ADR-0005](../docs/adr/0005-agent-and-client-listeners-and-device-auth.md)). After 10 failed attempts, the host invalidates every outstanding code.

To pair another device, create a new code in an SSH session on the server, as root:

```sh
runuser -u tomte -- /usr/local/bin/tomte-host pair \
  --mode remote --data-root /var/lib/tomte \
  --secrets-key-file /run/credentials/tomte.service/secrets-key
```

The installer prints the same command with `sudo -u tomte -H` instead of `runuser`. Both work. `pair` only writes to the database, so it runs next to the running host. It parses `--secrets-key-file` because remote mode requires the flag, and it never reads the key. A device that is already paired can also create a code on its Devices page.

## Sign in the Claude CLI

Bots and routines run the Claude CLI on the server, so the CLI must be signed in once.

The first way is the web UI. Pair a device, open Settings, Models, and use Sign in under Claude. The page shows a sign-in link to open in your own browser and a field for the code it gives you. The sign-in lands in the same config directory as the SSH one below, and the page shows it as soon as it completes.

The fallback is SSH. Sign in over SSH with a terminal (an SSH session with a TTY), never through the service:

```sh
sudo -u tomte -H /usr/local/bin/tomte-host auth-login \
  --mode remote --data-root /var/lib/tomte \
  --secrets-key-file /run/credentials/tomte.service/secrets-key
```

With no `sudo`, use `runuser -u tomte -- env HOME=/var/lib/tomte /usr/local/bin/tomte-host auth-login …` with the same flags. Follow the CLI's prompts, which print a URL to open in your own browser. After the CLI finishes, the host runs `auth status` once more and exits non-zero if the sign-in is not visible to it.

The web sign-in and the SSH login share one config directory, `/var/lib/tomte/claude`. Both run as `tomte`, and the host sets `CLAUDE_CONFIG_DIR` for every Claude CLI child itself. The sign-in lands in `claude/.credentials.json` in that directory. Every bot's sandbox denies that directory, so a bot cannot read the sign-in ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). The unit's `StandardInput=null` means `auth-login` can never run through the service.

Check the sign-in with the same flags:

```sh
sudo -u tomte -H /usr/local/bin/tomte-host auth-status \
  --mode remote --data-root /var/lib/tomte \
  --secrets-key-file /run/credentials/tomte.service/secrets-key
```

Anthropic's terms for your Claude subscription apply to unattended and remote use. Read the [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) and the [Usage Policy](https://www.anthropic.com/legal/aup) and decide whether they cover how you run tomte. The consumer terms, as published on the day this guide was written, restrict access through automated or non-human means (a bot or a script) unless Anthropic permits it. Whether tomte's use of the CLI falls under that is your decision, not the kit's.

Tomte ignores `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` in the service's environment, in remote and local mode alike, so a variable left in `/etc/tomte/tomte.env` or the unit never bills a bot by accident. Settings, Models names each one it ignored and shows each sign-in method's billing line and terms-risk line. To bill by API on purpose, set the custom provider on that page; it passes its own base URL and token to the CLI, and nothing else does.

## OAuth integrations

An integration that registers an OAuth client dynamically needs nothing from you. The host registers `<public URL>/oauth/callback` as the redirect URL and records it.

An integration with a static OAuth client, such as Google, needs `<public URL>/oauth/callback` registered with the provider. The integration's card in the web UI shows the exact address. Changing the public URL changes the redirect URL, so register the new one with the provider again. A dynamically registered client registers itself again on the next connect, and access and refresh tokens stay valid until then.

## Secrets key and backups

The secrets key is the 32-byte key for `secrets.enc`, the encrypted file in the data root that holds every stored secret. The installer creates it once and never overwrites or prints it.

`systemd-creds` encrypts the key with the host key in `/var/lib/systemd/credential.secret`, or with the TPM2 when the server has one. The encrypted credential is `/etc/credstore.encrypted/tomte.secrets-key` (root-only, mode `0600`). The unit loads it with `LoadCredentialEncrypted=secrets-key:…`. The key never appears in the unit file or in the environment of any process. The host receives it as a file at `$CREDENTIALS_DIRECTORY/secrets-key`, which is `/run/credentials/tomte.service/secrets-key`, and every bot's sandbox denies that path.

systemd grants the service user access to the credential file, so any process that runs as `tomte` can read it, and other users get "Permission denied". The protection from bots is the sandbox's deny list on that path, not file permissions. An SSH user who can become `tomte` can read the key too, which already means root-level access to the host's data.

On systemd older than 250 there is no `systemd-creds`. The installer then stores the key unencrypted in `/etc/credstore/tomte.secrets-key` (root-only, mode `0600`, in a mode `0700` directory) and adds the drop-in `/etc/systemd/system/tomte.service.d/10-credential.conf`. The drop-in resets `LoadCredentialEncrypted=` and sets `LoadCredential=secrets-key:/etc/credstore/tomte.secrets-key`.

**Losing the key loses every secret in `secrets.enc`.** The same happens when you restore `/var/lib/tomte` to a machine that does not have the key.

To back up, stop the host so the database is consistent, then copy the data root and the credential together:

```sh
sudo systemctl stop tomte
sudo tar -C / -czf tomte-backup.tar.gz var/lib/tomte etc/credstore.encrypted/tomte.secrets-key
sudo systemctl start tomte
```

The credential in that archive opens only on this machine, because the host key or the TPM that encrypted it stays here. To restore on a different machine, decrypt the key on the old machine and encrypt it again on the new one. Pipe it so the key never reaches a terminal or a file:

```sh
# old machine, as root, pipe into ssh to the new machine
systemd-creds decrypt --name=secrets-key /etc/credstore.encrypted/tomte.secrets-key - |
  ssh root@newserver 'systemd-creds encrypt --name=secrets-key - /etc/credstore.encrypted/tomte.secrets-key'
```

Run the installer on the new machine first (it creates a new key), stop the unit, replace the new key with the piped one, restore the data root, and start the unit. The `systemd-creds` pipe above was not run for this kit. Store backups encrypted. The archive holds the database, every bot's files, and the Claude sign-in.

## Service sandbox

The unit sandboxes the host with these directives, chosen so that bubblewrap still starts under all of them:

| Directive                                                                                        | Effect                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `User=tomte`, `Group=tomte`, `UMask=0077`                                                        | Unprivileged user; new files are private                                                       |
| `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty), `RestrictSUIDSGID=yes`                  | No privilege gain, no capabilities                                                             |
| `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `StateDirectory=tomte`              | Read-only file system except the data root and a private `/tmp`                                |
| `PrivateDevices=yes`, `ProtectProc=invisible`                                                    | Minimal `/dev`; other users' processes are hidden                                              |
| `ProtectControlGroups=yes`, `ProtectKernelModules=yes`, `ProtectClock=yes`                       | No cgroup writes, module loading or clock changes                                              |
| `LockPersonality=yes`, `RestrictRealtime=yes`, `RemoveIPC=yes`, `SystemCallArchitectures=native` | No personality changes, no realtime scheduling, SysV IPC removed on stop, native syscalls only |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`                                    | `AF_NETLINK` is for bubblewrap, which brings up loopback over netlink                          |

These directives are left out on purpose, because the sandbox needs what they block:

- `ProtectHostname=yes` denies `sethostname()`, which bubblewrap calls for the sandbox's UTS namespace. Its fresh `/proc` mount fails under it too.
- `RestrictNamespaces=` denies the namespaces bubblewrap creates.
- `SystemCallFilter=` with `@system-service` denies `unshare`, `mount` and `pivot_root`. The sandbox dies with SIGSYS.
- `ProtectKernelTunables=` and `ProtectKernelLogs=` over-mount parts of `/proc`, and the kernel then refuses bubblewrap's fresh `/proc` mount in its new user namespace.
- `ProcSubset=pid` hides `/proc/sys`, which bubblewrap reads to map users.
- `MemoryDenyWriteExecute=` would break Chrome's V8 in browser bots.
- `PrivateUsers=` lets bubblewrap start, but it remaps every other uid, including root's ownership of the credential. It was not checked with the Claude CLI and Chrome.

The sandbox runtime started and applied its deny-read list under every directive in the first table on Ubuntu 24.04 with systemd 255.

## Pause routines when you are away

A host nobody uses should not keep running routines. Set `TOMTE_PAUSE_AFTER_ABSENCE_DAYS` in `/etc/tomte/tomte.env` (the unit reads it through `EnvironmentFile`; `--pause-after-absence-days` on the command line wins) to a whole number of days, then run `sudo systemctl restart tomte`:

```sh
TOMTE_PAUSE_AFTER_ABSENCE_DAYS=14
```

The default is `0`: the pause is off. A negative or non-integer value stops the host from starting.

- **What counts as you being here.** Any request from one of your paired devices, except the event stream: opening the UI, a click, a message. A tab or the desktop app that only keeps the event stream open does not count. The clock is in the database, so a restart does not reset it, and turning the setting on starts the clock now.
- **The warning.** Two days before the pause (with a setting above 2) each bot that has an active routine gets a needs-you item: "Routines will pause in 2 days unless you open tomte".
- **The pause.** After that many days without you, every active routine is paused with the reason "no activity for N days", and each affected bot gets a needs-you item naming them. A routine that failed five runs in a row, or that you switched off, is left as it is. A run already working finishes.
- **Your return.** Your first request after a pause resumes the routines the absence stopped, without catching up on the occurrences you missed, and closes the two items. Routines paused for failures or by you stay paused.

## Upload size limit

A bot's Files section and the chat's attach button upload files to the bot's files folder on the server, streamed to disk. One file may be at most 1 GiB by default. On a small disk, lower it: set `TOMTE_MAX_UPLOAD_MIB` in `/etc/tomte/tomte.env` (`--max-upload-mib` on the command line wins) to a whole number of MiB, at least 1, then run `sudo systemctl restart tomte`:

```sh
TOMTE_MAX_UPLOAD_MIB=200
```

The limit is per file, not per folder or per day, so it does not stop a disk from filling. A file over it is refused with the limit named, and a folder's other files still go up. A reverse proxy in front of the host must allow bodies that large and not buffer them: in the `Caddyfile` kit's `reverse_proxy` this is the default; with nginx set `client_max_body_size` to the limit or higher and `proxy_request_buffering off`.

## Operate the service

```sh
systemctl status tomte
journalctl -u tomte -f
sudo systemctl restart tomte
```

After you edit `/etc/tomte/tomte.env`, restart the unit. `Restart=always` brings the host back after a crash (a `kill -9` was restarted in the Ubuntu 24.04 check) and after a reboot.

**Upgrade.** Re-run the installer: with no `--version` it installs the latest release, with `--version` a chosen one, with `--url` and `--sha256` your own binary. Your env file, key and data root stay. The service restarts.

**Uninstall.** The installer has no uninstall mode. Remove the parts by hand. This keeps the data root:

```sh
sudo systemctl disable --now tomte tomte-update.path
sudo rm -f /etc/systemd/system/tomte.service /etc/systemd/system/tomte-update.service /etc/systemd/system/tomte-update.path
sudo rm -rf /etc/systemd/system/tomte.service.d
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/tomte-host /usr/local/bin/tomte-host.prev
sudo rm -rf /etc/tomte /var/lib/tomte-update
```

The key stays in `/etc/credstore.encrypted/tomte.secrets-key` (or `/etc/credstore/tomte.secrets-key`) so a later install still opens `secrets.enc`. To delete everything, including every bot, secret and the Claude sign-in, also run `sudo rm -f /etc/credstore.encrypted/tomte.secrets-key /etc/credstore/tomte.secrets-key`, `sudo rm -rf /var/lib/tomte` and `sudo userdel tomte`. This cannot be undone.

## Limits and what is verified

- **No Docker image.** Docker's default seccomp profile may block the user namespaces bubblewrap needs, and the sandbox fails closed. A container also needs an unmasked `/proc`. Run the host on a server or VM with systemd.
- **No TLS in the host.** Put Caddy or `tailscale serve` in front of it, or use a private network.
- **systemd Linux only.** No other init system, macOS or Windows server ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)).
- **No browser bots on aarch64** until Chrome for Testing publishes a Linux ARM64 build.

What has been checked:

- On Linux, a synthetic `.credentials.json` canary in `<data root>/claude` was hidden from a bot's shell by the sandbox's deny list, and the real Claude CLI reported signed in with the file and signed out without it. This ran in a Debian container. No real sign-in was used.
- In a disposable Ubuntu 24.04 VM (arm64, systemd 255), the unit started as `tomte`, received the key as a credential with no key in the process environment, kept `secrets.enc` readable across restarts and reboots, and restarted after `kill -9`. Pairing tokens survived restarts and reboots. The plain-file fallback drop-in worked. With the default sysctl the sandbox failed and the installer warned. After loading the AppArmor profile above, the sandbox started under the unit's directives and denied the key, `tomte.db` and `<data root>/claude`, while the bot's own files stayed readable. The profile survived a reboot.
- In the same VM, Caddy 2.6 with this Caddyfile (plus `local_certs`, so no real certificate) proxied the web UI, pairing and the event stream: events arrived immediately through the proxy, and a foreign `Origin` got 403.
- The unit and installer were also checked statically and in local disposable environments only.
- On a real VPS (OVH, Ubuntu 26.04 x86_64, systemd 259): the installer, the AppArmor profiles (`bwrap` and `tomte-chrome`), Chrome's shared libraries and the sandbox check passed; `auth-login` over SSH signed in with `claude/.credentials.json` at mode `0600`; `tailscale serve` (Option B) served the UI, `/api/host-info` and pairing; and real browser routines (login wall, DataDome bot wall, takeover park + restart) ran against Chrome 158. A running host reports `claude: "signed-out"` until it is restarted after the first sign-in. Before the musl check was fixed, this glibc system (its loader is `/lib64/ld-linux-x86-64.so.2`, with no `/lib/ld-linux-*`) got the musl Claude CLI, which fails to start with `ENOENT`.
- The release download path ran against a local fixture laid out like a GitHub Release, in an Ubuntu 24.04 arm64 container with systemd: the `aarch64` pick, the `SHA256SUMS` check, `--version`, and the unit fetched from the release. A tampered binary, a `SHA256SUMS` without the entry, and a missing release each aborted before anything was installed. In that container the service never started, with the legacy `--url` path as well (systemd did not provide the credential there), so this covers the download and verification, not a running host. It has not run against GitHub Releases.

What has not been checked: Caddy certificate issuance, an OAuth connection, live view and takeover through a proxy, the sysctl option and the `systemd-creds` key migration.
