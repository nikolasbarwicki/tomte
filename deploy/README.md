# Deploy claudebot on a Linux server

This kit turns a fresh systemd Linux server into a running claudebot host in remote mode. It covers the install script, HTTPS with Caddy, a private-network option with Tailscale, and the two first-run steps: pairing a device and signing in the Claude CLI.

Remote mode is Linux-only ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). A Mac or Windows machine runs local mode instead.

## What the kit sets up

| Part             | Where                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System user      | `claudebot` (user and group), home `/var/lib/claudebot`, shell `/usr/sbin/nologin`                                                                                   |
| Data root        | `/var/lib/claudebot`, owner `claudebot:claudebot`, mode `0700`                                                                                                       |
| Binary           | `/usr/local/bin/claudebot-host`, `root:root`, mode `0755`                                                                                                            |
| Settings         | `/etc/claudebot/claudebot.env`, `root:root`, mode `0644`. Non-secret only: `CLAUDEBOT_HOST`, `CLAUDEBOT_PORT`, `CLAUDEBOT_PUBLIC_URL`, `CLAUDEBOT_ALLOW_PLAIN_HTTP`. |
| Secrets key      | A systemd credential named `secrets-key`: 32 random bytes in `/etc/credstore.encrypted/claudebot.secrets-key`, encrypted with `systemd-creds`                        |
| Unit             | `/etc/systemd/system/claudebot.service`, enabled, `Restart=always`                                                                                                   |
| Claude CLI       | Installed by `claudebot-host install-cli` into the data root                                                                                                         |
| Browser engine   | Installed by `claudebot-host install-browser` into the data root (x86_64 only, see below)                                                                            |
| Sandbox packages | `bubblewrap` and `socat`, installed with `apt-get` or `dnf` when missing                                                                                             |

The unit starts the host as `claudebot` with fixed flags: `--mode remote --data-root /var/lib/claudebot --secrets-key-file %d/secrets-key`. `%d` is the credentials directory systemd creates for the service, `/run/credentials/claudebot.service`. The host reads the key from that file only. It never reads the key from the environment.

Supported targets are systemd Linux on x86_64 and aarch64. The kit was run on Ubuntu 24.04 arm64 in a disposable VM and checked on Debian 12 in containers only (see [Limits and what is verified](#limits-and-what-is-verified)). Chrome for Testing publishes no Linux ARM64 build, so `install-browser` fails on aarch64. The installer warns and continues. Use an x86_64 server if you want browser bots.

## Prerequisites

- A server with systemd, root access over SSH, and outbound internet access (the installer downloads the Claude CLI and the browser engine, and the host talks to Anthropic and to your integrations' providers).
- `curl`, `sha256sum`, `systemctl`, `systemd-run`, `journalctl`, `runuser`, `useradd`, `getent`, `install`, `mktemp` and `head`. The installer stops before it changes anything when one is missing.
- A host binary for the server, `claudebot-host-linux-x64` or `claudebot-host-linux-arm64`, that the server can download, and its SHA-256. Build it on your machine with `bun run build:host linux-x64` (or `linux-arm64`). The output is in `dist/host/`.
- For HTTPS with Caddy: a domain name you control. For the Tailscale option: a tailnet.

### Ubuntu user namespaces

Bot shells and browser bots run under bubblewrap, which creates unprivileged user namespaces. Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, and with it bubblewrap fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.

When the sandbox cannot start, remote mode fails closed ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). The host refuses shell commands for every bot, and browser bots are unavailable. Nothing runs unsandboxed. Debian 12 allows unprivileged user namespaces by default, so it needs nothing here.

The installer never changes the sysctl and never installs an AppArmor profile. It detects the problem, warns, and finishes. You have two options.

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

The profile survives a reboot. Re-run the installer afterwards. Its sandbox check should now pass.

**Option 2: turn the restriction off for the whole system.**

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-claudebot-userns.conf
sudo sysctl --system
```

This is weaker. Every program on the server regains unprivileged user namespaces, which is the attack surface Ubuntu closed on purpose. This option has not been tested with the kit. Prefer the profile.

## Run the installer

Copy the `deploy/` directory of this repository and the binary to the server, so that `install.sh` and `claudebot.service` sit side by side. Print the binary's SHA-256 on your build machine (`shasum -a 256` on a Mac, `sha256sum` on Linux):

```sh
scp -r deploy root@server:claudebot-deploy
scp dist/host/claudebot-host-linux-x64 root@server:
shasum -a 256 dist/host/claudebot-host-linux-x64
```

Then run the installer on the server as root, with that SHA-256:

```sh
bash claudebot-deploy/install.sh \
  --url file:///root/claudebot-host-linux-x64 \
  --sha256 <hex> \
  --public-url https://claudebot.example.com
```

Parameters:

| Flag                    | Meaning                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url <URL>`           | Required. Where the server downloads the binary: `https://`, `http://` or `file://`. `{target}` in the URL becomes `linux-x64` or `linux-arm64`. |
| `--sha256 <hex>`        | Required. The expected SHA-256 of the download. On a mismatch the installer stops before it installs anything.                                   |
| `--public-url <origin>` | The origin users type into the browser, such as `https://claudebot.example.com`. Written as `CLAUDEBOT_PUBLIC_URL`.                              |
| `--host <addr>`         | The address the client listener binds. Default `127.0.0.1`. Written as `CLAUDEBOT_HOST`.                                                         |
| `--port <n>`            | The port the client listener binds. Default `8417`. Written as `CLAUDEBOT_PORT`.                                                                 |
| `--allow-plain-http`    | Writes `CLAUDEBOT_ALLOW_PLAIN_HTTP=1`. For a non-loopback bind without an `https://` public URL, on private networks only.                       |
| `--unit <path>`         | The unit to install. Default: `claudebot.service` next to the script.                                                                            |

The host refuses to start when it binds a non-loopback address and the public URL is not `https://`, unless `CLAUDEBOT_ALLOW_PLAIN_HTTP=1` is set.

The installer creates the user and data root, writes the env file, creates the key, installs the binary, the Claude CLI and the browser engine, starts the unit, checks the sandbox, and prints a pairing code and the sign-in command. A failure of `install-cli` stops it. A failure of `install-browser` only warns.

### Re-run it safely

The installer is idempotent. A re-run keeps the existing env file and the existing key, and only warns when a flag differs from the env file (edit the file and restart the unit to change a value). It replaces the binary and the unit file with the ones you pass, restarts the service, and prints a new pairing code. Put local unit changes in a drop-in under `/etc/systemd/system/claudebot.service.d/`, because a re-run overwrites `claudebot.service`.

### What the sandbox check means

After the unit is active, the installer runs `bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc -- /bin/true` as `claudebot` in a transient unit that carries every hardening directive of the installed unit. It also checks that `socat` exists.

If the check fails, the installer prints a warning that says bot shell commands and browser bots are unavailable, shows the check's output, and finishes anyway. On Ubuntu with the sysctl set to 1, the warning points at [Ubuntu user namespaces](#ubuntu-user-namespaces). A failed check does not stop the host. The host and its web UI run, but no bot runs a shell command.

`GET /api/host-info` reports `browserSandbox: true` whenever `bwrap` and `socat` are on the `PATH`, even when user namespaces are blocked. The installer's check is the real test, so trust it over the capability flag.

## HTTPS with Caddy

Caddy terminates TLS with automatic certificates and proxies to the host on loopback. The host keeps binding `127.0.0.1:8417`, and port 8417 stays closed to the network.

1. Point a DNS A record, and an AAAA record if the server has IPv6, at the server. Open ports 80 and 443 in your firewall, because Caddy uses them to obtain and renew the certificate.
2. Install Caddy from its official repository ([Caddy install instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)). The package runs Caddy as the `caddy` systemd service.
3. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and replace `claudebot.example.com` with your domain.
4. Set the public URL in `/etc/claudebot/claudebot.env` to exactly `https://<your domain>`, with no trailing path:

   ```
   CLAUDEBOT_PUBLIC_URL=https://claudebot.example.com
   ```

5. Restart both services:

   ```sh
   sudo systemctl restart claudebot
   sudo systemctl reload caddy
   ```

The Caddyfile is one site block. It proxies to port 8417, so change the port in it if you set `CLAUDEBOT_PORT` to another value:

```
claudebot.example.com {
	reverse_proxy 127.0.0.1:8417
}
```

Two details matter:

- **Host header.** The host answers 403 to any request whose `Host` header is not its own address or the public URL's host (a guard against DNS rebinding). It consults no `X-Forwarded-*` header. Caddy passes the original `Host` through by default, so leave it alone. A `CLAUDEBOT_PUBLIC_URL` that differs from the domain makes every request fail with 403 `bad host`.
- **Streaming.** The event stream and live view are server-sent events (`text/event-stream`). Caddy flushes those responses immediately, so the Caddyfile sets no `flush_interval` ([`reverse_proxy` streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)). The host serves no WebSocket to browsers.

If you passed `--public-url` to the installer on the first run, the env file already has the value.

## Private network with Tailscale

With Tailscale the host never faces the public internet. Install Tailscale on the server and on every device that uses claudebot, and join them to one tailnet. Then pick one option.

### Option A: bind the tailnet address, plain HTTP

WireGuard encrypts the link between your devices and the server, so plain HTTP inside the tailnet is not readable by the network. Bind the client listener to the server's tailnet address (`tailscale ip -4` prints it) and tell the host that plain HTTP is intended. Set these in `/etc/claudebot/claudebot.env`:

```
CLAUDEBOT_HOST=100.x.y.z
CLAUDEBOT_PORT=8417
CLAUDEBOT_PUBLIC_URL=http://100.x.y.z:8417
CLAUDEBOT_ALLOW_PLAIN_HTTP=1
```

Then run `sudo systemctl restart claudebot`. You can use the server's MagicDNS name in the public URL instead of the address, such as `http://myserver:8417`.

The host refuses a non-loopback bind unless the public URL is `https://` or `CLAUDEBOT_ALLOW_PLAIN_HTTP=1` is set, so the flag is required. Open claudebot at exactly the public URL you set. The host accepts the `Host` header of that URL and of the bound address, and answers 403 to any other name for the same machine.

Tailscale must be up before the host starts, or the bind fails. The unit has `Restart=always` with a 5-second delay, so it recovers once Tailscale is up. This was reasoned from the unit, not tested.

### Option B: `tailscale serve` with Tailscale HTTPS certificates

The host stays on loopback and `tailscale serve` terminates TLS with a certificate for the machine's `<machine>.<tailnet>.ts.net` name.

1. In the Tailscale admin console, open the [DNS page](https://console.tailscale.com/admin/dns), enable MagicDNS, and under **HTTPS Certificates** select **Enable HTTPS** ([Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). Your machine name appears in the public Certificate Transparency ledger.
2. Proxy HTTPS port 443 to the host. Tailscale's `serve` documentation says only `http://127.0.0.1` is supported as a proxy target:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8417
   ```

   `--bg` keeps it running across reboots and `tailscale` restarts. [`tailscale serve` reference](https://tailscale.com/kb/1242/tailscale-serve) lists the flags. `tailscale serve status` shows the result and `tailscale serve --https=443 off` removes it.

3. Set the public URL in `/etc/claudebot/claudebot.env` to `https://<machine>.<tailnet>.ts.net` and run `sudo systemctl restart claudebot`:

   ```
   CLAUDEBOT_PUBLIC_URL=https://myserver.tail1234.ts.net
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
runuser -u claudebot -- /usr/local/bin/claudebot-host pair \
  --mode remote --data-root /var/lib/claudebot \
  --secrets-key-file /run/credentials/claudebot.service/secrets-key
```

The installer prints the same command with `sudo -u claudebot -H` instead of `runuser`. Both work. `pair` only writes to the database, so it runs next to the running host. It parses `--secrets-key-file` because remote mode requires the flag, and it never reads the key. A device that is already paired can also create a code on its Devices page.

## Sign in the Claude CLI

Bots and routines run the Claude CLI on the server, so the CLI must be signed in once. Sign in over SSH with a terminal (an SSH session with a TTY), never through the service:

```sh
sudo -u claudebot -H /usr/local/bin/claudebot-host auth-login \
  --mode remote --data-root /var/lib/claudebot \
  --secrets-key-file /run/credentials/claudebot.service/secrets-key
```

With no `sudo`, use `runuser -u claudebot -- env HOME=/var/lib/claudebot /usr/local/bin/claudebot-host auth-login …` with the same flags. Follow the CLI's prompts, which print a URL to open in your own browser. After the CLI finishes, the host runs `auth status` once more and exits non-zero if the sign-in is not visible to it.

The SSH login and the unit share one config directory, `/var/lib/claudebot/claude`. Both run as `claudebot`, and the host sets `CLAUDE_CONFIG_DIR` for every Claude CLI child itself. The sign-in lands in `claude/.credentials.json` in that directory. Every bot's sandbox denies that directory, so a bot cannot read the sign-in ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)). The unit's `StandardInput=null` means `auth-login` can never run through the service.

Check the sign-in with the same flags:

```sh
sudo -u claudebot -H /usr/local/bin/claudebot-host auth-status \
  --mode remote --data-root /var/lib/claudebot \
  --secrets-key-file /run/credentials/claudebot.service/secrets-key
```

Anthropic's terms for your Claude subscription apply to unattended and remote use. Read the [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) and the [Usage Policy](https://www.anthropic.com/legal/aup) and decide whether they cover how you run claudebot. The consumer terms, as published on the day this guide was written, restrict access through automated or non-human means (a bot or a script) unless Anthropic permits it. Whether claudebot's use of the CLI falls under that is your decision, not the kit's.

## OAuth integrations

An integration that registers an OAuth client dynamically needs nothing from you. The host registers `<public URL>/oauth/callback` as the redirect URL and records it.

An integration with a static OAuth client, such as Google, needs `<public URL>/oauth/callback` registered with the provider. The integration's card in the web UI shows the exact address. Changing the public URL changes the redirect URL, so register the new one with the provider again. A dynamically registered client registers itself again on the next connect, and access and refresh tokens stay valid until then.

## Secrets key and backups

The secrets key is the 32-byte key for `secrets.enc`, the encrypted file in the data root that holds every stored secret. The installer creates it once and never overwrites or prints it.

`systemd-creds` encrypts the key with the host key in `/var/lib/systemd/credential.secret`, or with the TPM2 when the server has one. The encrypted credential is `/etc/credstore.encrypted/claudebot.secrets-key` (root-only, mode `0600`). The unit loads it with `LoadCredentialEncrypted=secrets-key:…`. The key never appears in the unit file or in the environment of any process. The host receives it as a file at `$CREDENTIALS_DIRECTORY/secrets-key`, which is `/run/credentials/claudebot.service/secrets-key`, and every bot's sandbox denies that path.

systemd grants the service user access to the credential file, so any process that runs as `claudebot` can read it, and other users get "Permission denied". The protection from bots is the sandbox's deny list on that path, not file permissions. An SSH user who can become `claudebot` can read the key too, which already means root-level access to the host's data.

On systemd older than 250 there is no `systemd-creds`. The installer then stores the key unencrypted in `/etc/credstore/claudebot.secrets-key` (root-only, mode `0600`, in a mode `0700` directory) and adds the drop-in `/etc/systemd/system/claudebot.service.d/10-credential.conf`. The drop-in resets `LoadCredentialEncrypted=` and sets `LoadCredential=secrets-key:/etc/credstore/claudebot.secrets-key`.

**Losing the key loses every secret in `secrets.enc`.** The same happens when you restore `/var/lib/claudebot` to a machine that does not have the key.

To back up, stop the host so the database is consistent, then copy the data root and the credential together:

```sh
sudo systemctl stop claudebot
sudo tar -C / -czf claudebot-backup.tar.gz var/lib/claudebot etc/credstore.encrypted/claudebot.secrets-key
sudo systemctl start claudebot
```

The credential in that archive opens only on this machine, because the host key or the TPM that encrypted it stays here. To restore on a different machine, decrypt the key on the old machine and encrypt it again on the new one. Pipe it so the key never reaches a terminal or a file:

```sh
# old machine, as root, pipe into ssh to the new machine
systemd-creds decrypt --name=secrets-key /etc/credstore.encrypted/claudebot.secrets-key - |
  ssh root@newserver 'systemd-creds encrypt --name=secrets-key - /etc/credstore.encrypted/claudebot.secrets-key'
```

Run the installer on the new machine first (it creates a new key), stop the unit, replace the new key with the piped one, restore the data root, and start the unit. The `systemd-creds` pipe above was not run for this kit. Store backups encrypted. The archive holds the database, every bot's files, and the Claude sign-in.

## Service sandbox

The unit sandboxes the host with these directives, chosen so that bubblewrap still starts under all of them:

| Directive                                                                                        | Effect                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `User=claudebot`, `Group=claudebot`, `UMask=0077`                                                | Unprivileged user; new files are private                                                       |
| `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty), `RestrictSUIDSGID=yes`                  | No privilege gain, no capabilities                                                             |
| `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `StateDirectory=claudebot`          | Read-only file system except the data root and a private `/tmp`                                |
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

## Operate the service

```sh
systemctl status claudebot
journalctl -u claudebot -f
sudo systemctl restart claudebot
```

After you edit `/etc/claudebot/claudebot.env`, restart the unit. `Restart=always` brings the host back after a crash (a `kill -9` was restarted in the Ubuntu 24.04 check) and after a reboot.

**Upgrade.** Re-run the installer with the new binary's `--url` and `--sha256`. Your env file, key and data root stay. The service restarts.

**Uninstall.** The installer has no uninstall mode. Remove the parts by hand. This keeps the data root:

```sh
sudo systemctl disable --now claudebot
sudo rm -f /etc/systemd/system/claudebot.service
sudo rm -rf /etc/systemd/system/claudebot.service.d
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/claudebot-host
sudo rm -rf /etc/claudebot
```

The key stays in `/etc/credstore.encrypted/claudebot.secrets-key` (or `/etc/credstore/claudebot.secrets-key`) so a later install still opens `secrets.enc`. To delete everything, including every bot, secret and the Claude sign-in, also run `sudo rm -f /etc/credstore.encrypted/claudebot.secrets-key /etc/credstore/claudebot.secrets-key`, `sudo rm -rf /var/lib/claudebot` and `sudo userdel claudebot`. This cannot be undone.

## Limits and what is verified

- **No Docker image.** Docker's default seccomp profile may block the user namespaces bubblewrap needs, and the sandbox fails closed. A container also needs an unmasked `/proc`. Run the host on a server or VM with systemd.
- **No TLS in the host.** Put Caddy or `tailscale serve` in front of it, or use a private network.
- **systemd Linux only.** No other init system, macOS or Windows server ([ADR-0006](../docs/adr/0006-remote-mode-is-linux-only.md)).
- **No browser bots on aarch64** until Chrome for Testing publishes a Linux ARM64 build.

What has been checked:

- On Linux, a synthetic `.credentials.json` canary in `<data root>/claude` was hidden from a bot's shell by the sandbox's deny list, and the real Claude CLI reported signed in with the file and signed out without it. This ran in a Debian container. No real sign-in was used.
- In a disposable Ubuntu 24.04 VM (arm64, systemd 255), the unit started as `claudebot`, received the key as a credential with no key in the process environment, kept `secrets.enc` readable across restarts and reboots, and restarted after `kill -9`. Pairing tokens survived restarts and reboots. The plain-file fallback drop-in worked. With the default sysctl the sandbox failed and the installer warned. After loading the AppArmor profile above, the sandbox started under the unit's directives and denied the key, `claudebot.db` and `<data root>/claude`, while the bot's own files stayed readable. The profile survived a reboot.
- In the same VM, Caddy 2.6 with this Caddyfile (plus `local_certs`, so no real certificate) proxied the web UI, pairing and the event stream: events arrived immediately through the proxy, and a foreign `Origin` got 403.
- The unit and installer were also checked statically and in local disposable environments only.

What has not been checked: a real VPS run. That includes a Claude sign-in over SSH that survives a restart, `claude/.credentials.json` having mode `0600` after a real sign-in, bubblewrap under the real unit on a public Ubuntu server, Caddy certificate issuance, an OAuth connection, and live view and takeover through a proxy. The sysctl option, the `systemd-creds` key migration, and `tailscale serve` on a real tailnet were not run either.
