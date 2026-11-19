#!/usr/bin/env bash
# VM smoke for the root update helper (ADR-0014, docs/smoke.md): writing a request as the service user starts the helper
# through tomte-update.path, as root, and the result comes back. Run as root on a DISPOSABLE systemd Linux machine; it installs
# the host, the units and /etc/tomte/update.conf there, and touches nothing on a developer machine's own services.
#
#   sudo bash scripts/smoke-update-helper.sh <tomte-host binary for this CPU> [<second tomte-host binary of another version>]
#
# The binary comes from `bun run build:host linux-x64` (or linux-arm64). With a second binary the smoke also performs a real
# update to it and checks host-info. Needs openssl 3, curl, and everything deploy/install.sh needs; no network is used: the
# "release" is a signed folder on disk (a throwaway key pinned into a copy of install.sh) read through file://.
set -euo pipefail

say() { printf '==> %s\n' "$*"; }
die() { printf 'SMOKE FAILED: %s\n' "$*" >&2; exit 1; }

[[ $# -ge 1 && -x $1 ]] || die "usage: smoke-update-helper.sh <tomte-host binary> [<second binary>]"
[[ $(id -u) -eq 0 ]] || die "run as root, in a disposable VM"
[[ -d /run/systemd/system ]] || die "systemd is not running here"
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bin_a=$(realpath "$1")
bin_b=${2:+$(realpath "$2")}

case $(uname -m) in
  x86_64 | amd64) target=linux-x64 ;;
  aarch64 | arm64) target=linux-arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
chmod 755 "$work"

version_of() { "$1" version | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
schema_of() { "$1" version | sed -n 's/.*"schemaVersion":\([0-9]*\).*/\1/p'; }

# A throwaway Ed25519 key; its public half is pinned into the copy of install.sh the way the owner pins the real one.
openssl genpkey -algorithm ed25519 -out "$work/key.pem" 2>/dev/null
public_key=$(openssl pkey -in "$work/key.pem" -pubout -outform DER | tail -c 32 | base64)

mkdir "$work/deploy"
cp "$here/deploy/tomte.service" "$work/deploy/"
sed "s|^RELEASE_PUBLIC_KEY=\".*\"\$|RELEASE_PUBLIC_KEY=\"$public_key\"|" "$here/deploy/install.sh" >"$work/deploy/install.sh"

repo=owner/tomte
releases=$work/releases/$repo/releases/download

publish() { # <binary>: a signed release folder for the binary's own version
  local binary=$1 version dir
  version=$(version_of "$binary")
  dir=$releases/v$version
  mkdir -p "$dir"
  cp "$binary" "$dir/tomte-host-$target"
  # The layout `release.ts manifest` writes (JSON.stringify with 2 spaces); install.sh reads the version line by line.
  printf '{\n  "version": "%s",\n  "shellApi": {\n    "min": 1,\n    "max": 1\n  },\n  "schemaVersion": %s\n}\n' \
    "$version" "$(schema_of "$binary")" >"$dir/release.json"
  (cd "$dir" && sha256sum release.json "tomte-host-$target" >SHA256SUMS)
  openssl pkeyutl -sign -inkey "$work/key.pem" -rawin -in "$dir/SHA256SUMS" -out "$dir/SHA256SUMS.sig"
}

request() { # <json>: written the way the host writes it, as the service user
  runuser -u tomte -- sh -c 'umask 077 && cat > /var/lib/tomte/updates/request.json.tmp && mv /var/lib/tomte/updates/request.json.tmp /var/lib/tomte/updates/request.json' <<<"$1"
}

await_result() { # <request id>: waits for result.json to name it
  for _ in $(seq 1 120); do
    if grep -q "\"requestId\":\"$1\"" /var/lib/tomte/updates/result.json 2>/dev/null; then return 0; fi
    sleep 1
  done
  journalctl -u tomte-update.service -n 40 --no-pager >&2 || true
  die "no result for request $1 within 120 s"
}

version_a=$(version_of "$bin_a")
publish "$bin_a"
say "Installing $version_a from the throwaway release"
TOMTE_RELEASE_BASE_URL=file://$work/releases bash "$work/deploy/install.sh" --repo "$repo" --version "$version_a"

say "The units and the configuration are in place, root-owned"
systemctl is-active --quiet tomte-update.path || die "tomte-update.path is not active"
[[ $(stat -c %U:%a /etc/tomte/update.conf) == root:644 ]] || die "update.conf is not root-owned 0644"
[[ $(stat -c %U /usr/local/bin/tomte-host) == root ]] || die "the host binary is not root-owned"
grep -q "^PUBLIC_KEY=$public_key\$" /etc/tomte/update.conf || die "update.conf does not carry the pinned key"

say "The service user cannot write its own binary"
if runuser -u tomte -- sh -c 'echo x >> /usr/local/bin/tomte-host' 2>/dev/null; then die "the service user wrote the binary"; fi

say "A request for the installed version reaches the helper through the path unit"
request "{\"kind\":\"apply\",\"id\":\"smoke-1\",\"version\":\"$version_a\"}"
await_result smoke-1
grep -q '"outcome":"unchanged"' /var/lib/tomte/updates/result.json || die "expected unchanged: $(cat /var/lib/tomte/updates/result.json)"
[[ $(stat -c %U /var/lib/tomte/updates/result.json) == tomte ]] || die "result.json is not the service user's"
[[ ! -e /var/lib/tomte/updates/request.json ]] || die "the request was not consumed"
journalctl -u tomte-update.service --no-pager | grep -q "request smoke-1: unchanged" || die "the helper's journal has no line for the request"

say "An unpublished version is refused and the host is untouched"
request '{"kind":"apply","id":"smoke-2","version":"99.0.0"}'
await_result smoke-2
grep -q '"outcome":"refused"' /var/lib/tomte/updates/result.json || die "expected refused: $(cat /var/lib/tomte/updates/result.json)"
systemctl is-active --quiet tomte.service || die "tomte.service is not active after a refused request"

if [[ -n $bin_b ]]; then
  version_b=$(version_of "$bin_b")
  [[ $version_b != "$version_a" ]] || die "the second binary reports the same version as the first"
  publish "$bin_b"
  say "A real update to $version_b"
  request "{\"kind\":\"apply\",\"id\":\"smoke-3\",\"version\":\"$version_b\"}"
  await_result smoke-3
  grep -q '"outcome":"updated"' /var/lib/tomte/updates/result.json || die "expected updated: $(cat /var/lib/tomte/updates/result.json)"
  [[ $(version_of /usr/local/bin/tomte-host) == "$version_b" ]] || die "the installed binary is not $version_b"
  [[ $(version_of /usr/local/bin/tomte-host.prev) == "$version_a" ]] || die "the previous binary is not $version_a"
  result_has() { grep -q "$1" /var/lib/tomte/updates/result.json || die "expected $1: $(cat /var/lib/tomte/updates/result.json)"; }
  installed_is() { [[ $(version_of /usr/local/bin/tomte-host) == "$1" ]] || die "$2"; }

  say "A restoreSnapshot that is not exactly true is an invalid request and changes nothing"
  request '{"kind":"rollback","id":"smoke-4","restoreSnapshot":false}'
  await_result unknown
  result_has '"outcome":"refused"'
  installed_is "$version_b" "an invalid rollback request changed the binary"

  if [[ $(schema_of /usr/local/bin/tomte-host.prev) == "$(schema_of /usr/local/bin/tomte-host)" ]]; then
    say "Same schema: a confirmed restore is refused, nothing is touched"
    request '{"kind":"rollback","id":"smoke-5","restoreSnapshot":true}'
    await_result smoke-5
    result_has '"outcome":"refused"'
    result_has 'would only lose changes'
    installed_is "$version_b" "a refused restore changed the binary"
  else
    say "Schema change: an unconfirmed rollback is refused, a confirmed one restores the snapshot taken before the update"
    request '{"kind":"rollback","id":"smoke-5"}'
    await_result smoke-5
    result_has '"outcome":"refused"'
    installed_is "$version_b" "an unconfirmed rollback changed the binary"
    runuser -u tomte -- cp /var/lib/tomte/tomte.db "/var/lib/tomte/updates/pre-$version_b.db"
    request '{"kind":"rollback","id":"smoke-6","restoreSnapshot":true}'
    await_result smoke-6
    result_has '"snapshotRestored":true'
  fi

  if [[ $(version_of /usr/local/bin/tomte-host) == "$version_b" ]]; then
    say "Rolling back"
    request '{"kind":"rollback","id":"smoke-7"}'
    await_result smoke-7
    result_has '"outcome":"rolled-back"'
    result_has '"snapshotRestored":false'
  fi
  installed_is "$version_a" "the rollback did not restore $version_a"
  systemctl is-active --quiet tomte.service || die "tomte.service is not active after the rollback"
fi

say "update helper smoke passed"
