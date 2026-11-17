#!/usr/bin/env bash
# Installs the tomte host as a systemd service on a Linux server. Run as root; `-h` explains the flags.
set -euo pipefail
umask 022

SERVICE=tomte
SERVICE_USER=tomte
DATA_ROOT=/var/lib/tomte
BIN=/usr/local/bin/tomte-host
ETC_DIR=/etc/tomte
ENV_FILE=$ETC_DIR/tomte.env
UNIT_DEST=/etc/systemd/system/$SERVICE.service
DROPIN_DIR=/etc/systemd/system/$SERVICE.service.d
ENC_CREDENTIAL=/etc/credstore.encrypted/$SERVICE.secrets-key
PLAIN_CREDENTIAL=/etc/credstore/$SERVICE.secrets-key
# Where systemd exposes the credential to the service. `pair` and `auth-login` only parse this path (remote mode requires the flag); neither reads the key.
KEY_FILE=/run/credentials/$SERVICE.service/secrets-key
HOST_FLAGS=(--mode remote --data-root "$DATA_ROOT" --secrets-key-file "$KEY_FILE")
# The unit's own sandboxing directives; the sandbox check applies every one of them found in the installed unit.
SANDBOX_DIRECTIVE='^(NoNewPrivileges|Protect[A-Za-z]*|Private[A-Za-z]*|Restrict[A-Za-z]*|Lock[A-Za-z]*|RemoveIPC|SystemCall[A-Za-z]*|MemoryDenyWriteExecute|CapabilityBoundingSet|AmbientCapabilities|UMask|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|TemporaryFileSystem)$'
START_DEADLINE_SECONDS=30
# Restart=always with RestartSec=5: a host that crashes at startup is only visibly not active after the restart delay.
STABLE_SECONDS=7

DEFAULT_HOST=127.0.0.1
DEFAULT_PORT=8417
# GitHub repository (OWNER/REPO) whose Releases hold the host binaries. Empty in the source tree on purpose: the release
# workflow fills it in on the copy it publishes as a release asset, and --repo or $TOMTE_REPO sets it otherwise.
DEFAULT_REPO=""
# Test seam (and GitHub Enterprise): where release downloads come from, as {base}/{repo}/releases/....
RELEASE_BASE_URL=${TOMTE_RELEASE_BASE_URL:-https://github.com}

usage() {
  cat <<'EOF'
Usage: install.sh [--repo <OWNER/REPO>] [--version <version>] [options]
       install.sh --url <URL> --sha256 <hex> [options]

Installs the tomte host as a systemd service running as the unprivileged
"tomte" user. Run as root on a systemd Linux server (x86_64 or aarch64).

By default the script downloads the host binary for this server's CPU from a GitHub
Release, together with the release's SHA256SUMS, and aborts before installing anything
when the checksum does not match or has no entry for the binary.

Download source (the default):
  --repo <OWNER/REPO>  GitHub repository that publishes the releases. Also read from
                       $TOMTE_REPO. The copy of this script attached to a release
                       has it filled in; a copy from the source tree needs it.
  --version <version>  Release to install, e.g. 0.2.0 or v0.2.0-rc.1. Default: the
                       latest release. GitHub's "latest" skips pre-releases, so
                       installing a pre-release needs this flag.

Download source (your own file; replaces the above):
  --url <URL>          Download URL of the host binary. "{target}" in the URL is
                       replaced with linux-x64 or linux-arm64. Needs --sha256.
  --sha256 <hex>       Expected SHA-256 of the downloaded file. A mismatch aborts
                       before anything is installed. Needs --url.

Options (written to /etc/tomte/tomte.env on the first run; a re-run keeps
the file and only warns when a flag differs from it):
  --public-url <origin>  Origin users type into the browser, e.g. https://tomte.example.com
  --host <addr>          Address the client listener binds (default 127.0.0.1)
  --port <n>             Port the client listener binds (default 8417)
  --allow-plain-http     Allow a non-loopback bind without an https public URL (private networks only)

  --unit <path>          The systemd unit to install (default: tomte.service next to this
                         script; a script that is not in a checkout takes it from the release)
  -h, --help             Show this help
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

url=""
sha256=""
repo=""
version=""
public_url=""
host=""
port=""
allow_plain_http=""
unit=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --allow-plain-http)
      allow_plain_http=1
      shift
      continue
      ;;
    --url | --sha256 | --repo | --version | --public-url | --host | --port | --unit)
      [[ $# -ge 2 ]] || die "$1 needs a value (see -h)"
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
  case $1 in
    --url) url=$2 ;;
    --sha256) sha256=$2 ;;
    --repo) repo=$2 ;;
    --version) version=$2 ;;
    --public-url) public_url=$2 ;;
    --host) host=$2 ;;
    --port) port=$2 ;;
    --unit) unit=$2 ;;
  esac
  shift 2
done

if [[ -n $url || -n $sha256 ]]; then
  [[ -n $url ]] || die "--sha256 needs --url (see -h)"
  [[ -n $sha256 ]] || die "--url needs --sha256 (see -h)"
  [[ -z $repo && -z $version ]] || die "--repo and --version choose a GitHub release, which --url replaces; pass one or the other"
  [[ $sha256 =~ ^[0-9a-fA-F]{64}$ ]] || die "--sha256 must be 64 hexadecimal characters"
else
  repo=${repo:-${TOMTE_REPO:-$DEFAULT_REPO}}
  [[ -n $repo ]] || die "no GitHub repository to download from: pass --repo OWNER/REPO (or set TOMTE_REPO), or pass --url and --sha256"
  [[ $repo =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "--repo must look like OWNER/REPO"
  if [[ -n $version ]]; then
    version=${version#v}
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--version must look like 1.2.0 or v1.2.0-rc.1"
  fi
fi
# These values are written into an EnvironmentFile line, so only characters that cannot change its meaning are accepted.
if [[ -n $host ]]; then
  [[ $host =~ ^[][A-Za-z0-9.:_-]+$ ]] || die "--host \"$host\" is not an address"
fi
if [[ -n $port ]]; then
  if ! [[ $port =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then die "--port must be 1-65535"; fi
  port=$((10#$port))
fi
if [[ -n $public_url ]]; then
  [[ $public_url =~ ^https?://[][A-Za-z0-9.:_-]+/?$ ]] || die "--public-url must be an http(s) origin such as https://tomte.example.com"
  public_url=${public_url%/}
fi

# --- 1. Preflight: nothing here changes the system -------------------------------------------

[[ $(uname -s) == Linux ]] || die "this installer supports Linux servers only (remote mode is Linux-only)"
[[ $(id -u) -eq 0 ]] || die "run as root (for example: sudo bash install.sh ...)"
[[ -d /run/systemd/system ]] || die "systemd is not running on this server; only systemd Linux is supported"
for tool in curl sha256sum systemctl systemd-run journalctl runuser useradd getent install mktemp head; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed"
done

case $(uname -m) in
  x86_64 | amd64) target=linux-x64 ;;
  aarch64 | arm64) target=linux-arm64 ;;
  *) die "unsupported CPU architecture $(uname -m): only x86_64 and aarch64 are supported" ;;
esac
url=${url//\{target\}/$target}

# The unit comes from --unit, else from next to this script, else (a script downloaded on its own) from the release.
unit_from_release=""
if [[ -z $unit && -f ${BASH_SOURCE[0]:-} && -r $(dirname -- "${BASH_SOURCE[0]}")/tomte.service ]]; then
  unit=$(dirname -- "${BASH_SOURCE[0]}")/tomte.service
fi
if [[ -z $unit ]]; then
  [[ -z $url ]] || die "there is no tomte.service next to this script: pass --unit <path>"
  unit_from_release=1
else
  [[ -r $unit ]] || die "unit file $unit not found or not readable (pass --unit <path>)"
fi

# --- 2. Download and verify ------------------------------------------------------------------

tmp=$(mktemp -d)
staged_bin=""
cleanup() {
  rm -rf -- "$tmp"
  if [[ -n $staged_bin ]]; then rm -f -- "$staged_bin"; fi
}
trap cleanup EXIT

# A redirect may only lead to https, so a downgrade cannot swap the checksum file and the binary together.
redirect_protocols='=https,http,file'
fetch() { # <url> <destination>
  curl --fail --location --silent --show-error --proto '=https,http,file' --proto-redir "$redirect_protocols" \
    --output "$2" -- "$1" || die "download failed: $1"
}

verify() { # <file> <expected sha256> <what>
  local actual
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  if [[ $actual != "$2" ]]; then
    printf 'error: SHA-256 mismatch for %s; nothing was installed\n  expected: %s\n  actual:   %s\n' "$3" "$2" "$actual" >&2
    exit 1
  fi
}

# Sets $listed to the checksum SHA256SUMS lists for <name>; a missing or repeated entry aborts.
listed=""
lookup_checksum() { # <SHA256SUMS file> <name>
  local sum name matches=0
  listed=""
  while read -r sum name || [[ -n $sum ]]; do
    if [[ ${name#\*} == "$2" ]]; then
      matches=$((matches + 1))
      listed=$(printf '%s' "$sum" | tr 'A-F' 'a-f')
    fi
  done <"$1"
  ((matches > 0)) || die "SHA256SUMS has no entry for $2; nothing was installed"
  ((matches == 1)) || die "SHA256SUMS lists $2 $matches times; nothing was installed"
  [[ $listed =~ ^[0-9a-f]{64}$ ]] || die "SHA256SUMS has a malformed checksum for $2; nothing was installed"
}

if [[ -n $url ]]; then
  say "Downloading the host binary ($target)"
  fetch "$url" "$tmp/tomte-host"
  verify "$tmp/tomte-host" "$(printf '%s' "$sha256" | tr 'A-F' 'a-f')" "$target host binary"
else
  redirect_protocols='=https'
  if [[ $RELEASE_BASE_URL != https://* ]]; then redirect_protocols='=https,http,file'; fi
  if [[ -n $version ]]; then
    release_url=$RELEASE_BASE_URL/$repo/releases/download/v$version
    say "Installing tomte $version from $repo"
  else
    release_url=$RELEASE_BASE_URL/$repo/releases/latest/download
    say "Installing the latest tomte release of $repo (a pre-release needs --version)"
  fi
  asset=tomte-host-$target
  say "Downloading SHA256SUMS and the host binary ($target)"
  fetch "$release_url/SHA256SUMS" "$tmp/SHA256SUMS"
  fetch "$release_url/$asset" "$tmp/tomte-host"
  lookup_checksum "$tmp/SHA256SUMS" "$asset"
  verify "$tmp/tomte-host" "$listed" "$asset"
  if [[ -n $unit_from_release ]]; then
    say "Downloading tomte.service"
    fetch "$release_url/tomte.service" "$tmp/tomte.service"
    lookup_checksum "$tmp/SHA256SUMS" tomte.service
    verify "$tmp/tomte.service" "$listed" tomte.service
    unit=$tmp/tomte.service
  fi
fi
say "Checksum verified"

# --- 3. Sandbox dependencies -----------------------------------------------------------------

if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing bubblewrap and socat with apt-get"
    { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap socat; } ||
      warn "apt-get could not install bubblewrap and socat; install them yourself, or bot shells and browser bots stay unavailable"
  elif command -v dnf >/dev/null 2>&1; then
    say "Installing bubblewrap and socat with dnf"
    dnf install -y bubblewrap socat ||
      warn "dnf could not install bubblewrap and socat; install them yourself, or bot shells and browser bots stay unavailable"
  else
    warn "bubblewrap and socat are missing and there is no apt-get or dnf: install them yourself, or bot shells and browser bots stay unavailable"
  fi
fi

# --- 4. User and data root -------------------------------------------------------------------

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  say "Creating the $SERVICE_USER system user"
  useradd --system --user-group --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_ROOT"

# --- 5. Non-secret configuration -------------------------------------------------------------

env_value() {
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2-
}

warn_if_differs() { # <flag> <KEY> <wanted>
  [[ -n $3 && $(env_value "$2") != "$3" ]] &&
    warn "$ENV_FILE already sets $2 to \"$(env_value "$2")\", not \"$3\" as $1 says; it was kept, edit the file and run: systemctl restart $SERVICE"
  return 0
}

if [[ -e $ENV_FILE ]]; then
  say "Keeping the existing $ENV_FILE"
  warn_if_differs --public-url TOMTE_PUBLIC_URL "$public_url"
  warn_if_differs --host TOMTE_HOST "$host"
  warn_if_differs --port TOMTE_PORT "$port"
  warn_if_differs --allow-plain-http TOMTE_ALLOW_PLAIN_HTTP "$allow_plain_http"
else
  say "Writing $ENV_FILE"
  {
    echo "# tomte host configuration: non-secret settings only. The secrets key is a systemd credential and never goes here."
    echo "# After editing: systemctl restart $SERVICE"
    echo "TOMTE_HOST=${host:-$DEFAULT_HOST}"
    echo "TOMTE_PORT=${port:-$DEFAULT_PORT}"
    if [[ -n $public_url ]]; then echo "TOMTE_PUBLIC_URL=$public_url"; fi
    if [[ -n $allow_plain_http ]]; then echo "TOMTE_ALLOW_PLAIN_HTTP=1"; fi
  } >"$tmp/tomte.env"
  install -d -m 0755 "$ETC_DIR"
  install -o root -g root -m 0644 "$tmp/tomte.env" "$ENV_FILE"
fi

# --- 6. Secrets key credential ---------------------------------------------------------------

if [[ -e $ENC_CREDENTIAL || -e $PLAIN_CREDENTIAL ]]; then
  say "Keeping the existing secrets key"
elif command -v systemd-creds >/dev/null 2>&1; then
  say "Creating the secrets key as an encrypted systemd credential"
  install -d -m 0700 "$(dirname "$ENC_CREDENTIAL")"
  # Written under a temporary name so an interrupted run cannot leave a half-written file that a re-run would keep.
  staged_key=$ENC_CREDENTIAL.new.$$
  if ! (umask 077 && head -c 32 /dev/urandom | systemd-creds encrypt --name=secrets-key - "$staged_key"); then
    rm -f -- "$staged_key"
    die "systemd-creds could not encrypt the secrets key"
  fi
  mv -f -- "$staged_key" "$ENC_CREDENTIAL"
else
  warn "systemd-creds is not available (systemd older than 250): the secrets key is stored unencrypted in $PLAIN_CREDENTIAL (root only, mode 0600)"
  install -d -m 0700 "$(dirname "$PLAIN_CREDENTIAL")"
  staged_key=$PLAIN_CREDENTIAL.new.$$
  if ! (umask 077 && head -c 32 /dev/urandom >"$staged_key"); then
    rm -f -- "$staged_key"
    die "could not create the secrets key"
  fi
  mv -f -- "$staged_key" "$PLAIN_CREDENTIAL"
fi
if [[ ! -e $ENC_CREDENTIAL && -e $PLAIN_CREDENTIAL ]]; then
  install -d -m 0755 "$DROPIN_DIR"
  cat >"$DROPIN_DIR/10-credential.conf" <<EOF
[Service]
LoadCredentialEncrypted=
LoadCredential=secrets-key:$PLAIN_CREDENTIAL
EOF
fi

# --- 7. Binary -------------------------------------------------------------------------------

say "Installing $BIN"
staged_bin=$(dirname "$BIN")/.tomte-host.new.$$
install -o root -g root -m 0755 "$tmp/tomte-host" "$staged_bin"
mv -f -- "$staged_bin" "$BIN"
staged_bin=""

# --- 8. Managed Claude CLI and browser engine ------------------------------------------------

# runuser keeps the caller's environment, so HOME and friends are set to what the unit gives the service: the CLI and engine write under the data root, never /root.
as_service_user() {
  (cd "$DATA_ROOT" && runuser -u "$SERVICE_USER" -- env HOME="$DATA_ROOT" USER="$SERVICE_USER" LOGNAME="$SERVICE_USER" "$@")
}

say "Installing the Claude CLI"
as_service_user "$BIN" install-cli "${HOST_FLAGS[@]}" || die "tomte-host install-cli failed (see above)"
say "Installing the browser engine"
as_service_user "$BIN" install-browser "${HOST_FLAGS[@]}" ||
  warn "tomte-host install-browser failed (see above): browser bots are unavailable until it succeeds; re-run this script to retry"

# --- 9. Unit ---------------------------------------------------------------------------------

say "Installing and starting $SERVICE.service"
install -o root -g root -m 0644 "$unit" "$UNIT_DEST"
systemctl daemon-reload
systemctl enable "$SERVICE.service"
systemctl restart "$SERVICE.service"

stable=0
for ((elapsed = 0; elapsed < START_DEADLINE_SECONDS && stable < STABLE_SECONDS; elapsed++)); do
  sleep 1
  if systemctl is-active --quiet "$SERVICE.service"; then stable=$((stable + 1)); else stable=0; fi
done
if ((stable < STABLE_SECONDS)); then
  journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true
  die "$SERVICE.service did not stay active; the last journal lines are above"
fi
say "$SERVICE.service is active"

# --- 10. Browser sandbox check under the unit's hardening ------------------------------------

properties=()
section=""
while IFS= read -r line || [[ -n $line ]]; do
  if [[ $line == "["*"]" ]]; then
    section=$line
  elif [[ $section == "[Service]" && $line =~ ^([A-Za-z]+)= && ${BASH_REMATCH[1]} =~ $SANDBOX_DIRECTIVE ]]; then
    properties+=(-p "$line")
  fi
done <"$UNIT_DEST"

say "Checking that the sandbox starts under the unit's hardening"
sandbox_check='command -v socat >/dev/null || { echo "socat is not installed" >&2; exit 1; }
exec bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc -- /bin/true'
sandbox_ok=1
if sandbox_output=$(systemd-run --wait --pipe --quiet --collect --uid="$SERVICE_USER" --gid="$SERVICE_USER" \
  "${properties[@]}" /bin/sh -c "$sandbox_check" 2>&1); then
  say "The sandbox starts"
else
  sandbox_ok=""
  warn "the sandbox cannot start on this server: bot shell commands and browser bots are UNAVAILABLE (remote mode refuses shell commands for every bot when the sandbox cannot start). The install itself completed."
  printf 'sandbox check output:\n%s\n' "$sandbox_output" >&2
  if [[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true) == 1 ]]; then
    warn "kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04 default) stops bubblewrap creating namespaces. This script does not change it: see the Ubuntu user namespaces section of deploy/README.md for the options and their trade-offs."
  fi
fi

# --- 11. Pairing code ------------------------------------------------------------------------

pair_command="sudo -u $SERVICE_USER -H $BIN pair ${HOST_FLAGS[*]}"
sign_in_command="sudo -u $SERVICE_USER -H $BIN auth-login ${HOST_FLAGS[*]}"
as_service_user "$BIN" pair "${HOST_FLAGS[@]}" >"$tmp/pair-code" || die "tomte-host pair failed (see above)"
pairing_code=$(<"$tmp/pair-code")
[[ -n $pairing_code ]] || die "tomte-host pair printed no code"

effective_public_url=$(env_value TOMTE_PUBLIC_URL)
effective_host=$(env_value TOMTE_HOST)
effective_host=${effective_host:-$DEFAULT_HOST}
[[ $effective_host == *:* && $effective_host != "["* ]] && effective_host="[$effective_host]"
effective_port=$(env_value TOMTE_PORT)
effective_port=${effective_port:-$DEFAULT_PORT}

cat <<EOF

================================================================================
tomte is installed and running.

1. Pair your first device. Pairing code:

     $pairing_code

   It expires in 10 minutes. Create a new one with:

     $pair_command

EOF
if [[ -n $effective_public_url ]]; then
  echo "   Enter the code at $effective_public_url"
else
  cat <<EOF
   No public URL is set, so the host only listens on http://$effective_host:$effective_port,
   which your browser cannot reach from outside this server. Put Caddy in front of it or
   use Tailscale, then set TOMTE_PUBLIC_URL in $ENV_FILE: see the Caddy and Tailscale
   sections of deploy/README.md.
EOF
fi

# --- 12. Sign-in command ---------------------------------------------------------------------

cat <<EOF

2. Sign in the Claude CLI once, in an SSH session with a TTY (not through the service):

     $sign_in_command

   No sudo on this server? Replace "sudo -u $SERVICE_USER -H" with
   "runuser -u $SERVICE_USER -- env HOME=$DATA_ROOT".

   Anthropic's terms for your Claude subscription apply to unattended and remote use of
   the CLI; check that they cover how you run tomte.
EOF
if [[ -z $sandbox_ok ]]; then
  cat <<'EOF'

Reminder: the sandbox check failed above. Bot shell commands and browser bots stay
unavailable until it passes.
EOF
fi
echo "================================================================================"
