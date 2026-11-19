# 0014: A root helper replaces the host binary; the service user can only ask

Status: accepted

## Context

A remote host runs as the unprivileged `tomte` user under `ProtectSystem=strict`, and its binary, `/usr/local/bin/tomte-host`, is `root:root` (ADR-0005, ADR-0006, `deploy/tomte.service`). That is deliberate: a bot that takes over the host process must not be able to change the code that runs next, or run as root after a restart. But a host that cannot be updated from its own UI is a host nobody updates, so the update has to be done by something that can write the binary, without the service user gaining that power.

The release is already signed: `SHA256SUMS` carries every file's checksum and `SHA256SUMS.sig` is the Ed25519 signature of it under a public key pinned in `deploy/install.sh` (ticket 10; no trust on first use). `release.json` in the signed set says the release's version and database schema.

## Decision

**The boundary is a version string.** The service user can write one file in its own state directory, `<dataRoot>/updates/request.json`:

```json
{ "kind": "apply", "id": "<request id>", "version": "0.4.2" }
{ "kind": "rollback", "id": "<request id>" }
```

and read `result.json` beside it. A request carries no bytes, no URL and no path; the schema is strict, the version must match `MAJOR.MINOR.PATCH[-pre]` (`@tomte/contract/update`). The service user can therefore at most pick a release that the owner's key signed, or ask for the one previous binary back.

**Root side.** `tomte-update.path` (`PathExists=<dataRoot>/updates/request.json`, level-triggered so a request written during a reboot still starts it) starts `tomte-update.service`, a root `Type=oneshot` unit running `tomte-host apply-update`. `install.sh` writes both units and `/etc/tomte/update.conf`; the main unit and its hardening are untouched and the binary stays root-owned. `apply-update`:

- refuses to run as anyone but root, and takes no flags and no environment: everything but the request comes from `/etc/tomte/update.conf`, which it requires to be a regular file owned by root that no one else can write. The file holds the repository (`REPO`), the release public key (`PUBLIC_KEY`), the paths and unit names, and the release base URL. `install.sh` writes the key from its own pinned constant, never from a download, so nothing the host or the network says can replace it;
- reads `request.json` without following a link (`O_NOFOLLOW`), at most 4 KiB, and deletes it: a request is handled once, and a request id already handled is ignored;
- downloads `SHA256SUMS`, `SHA256SUMS.sig`, `release.json` and the binary for this CPU into a root-only staging directory, verifies the signature with WebCrypto (`Ed25519`, no dependency) and every file against the signed sums, and runs the downloaded binary's `version` command (root runs only a verified file) to check it reports the requested version and the schema `release.json` names. Any failure ends in a `refused` result and changes nothing;
- refuses a release whose schema is older than the installed binary's, because an older host cannot open a newer database (the host itself refuses to start on one: `DatabaseTooNew`);
- keeps exactly one previous binary, `tomte-host.prev`, copied aside and renamed into place, then swaps the new one in with a rename in the same directory, so the binary is always whole;
- restarts the unit and requires 7 stable seconds of `systemctl is-active` and `/api/host-info` reporting the target version (the loopback address comes from the service's `EnvironmentFile`), within 90 seconds;
- on failure, rolls back by itself: stops the unit, restores `updates/pre-<version>.db` (the snapshot the host took before writing the request) over the database and removes its `-wal` and `-shm` when that snapshot exists, puts `.prev` back, starts the unit and requires the same gate of the old version. The result names the reason and the version rolled back to (`reverted`), or says `failed` when the old host does not come back either;
- writes `result.json` as the service user (`runuser`), as it does every file it restores in the service's directories, so a link planted there cannot make root write elsewhere.

A **rollback request** restores `.prev` the same way, and is refused when the previous binary's schema is older than the database's (the answer is then the snapshot, restored only by a rollback request that confirms it; see the 2026-11-19 amendment on manual rollback).

**Crash safety.** A root lock (the host's data-root lock, in the helper's own `/var/lib/tomte-update`) is held for the whole run. A journal, `journal.json` there, is written before each step: `requested`, `saving-previous`, `swapping`, `restarting`, `rolling-back`, `finished`. A target equal to the installed version is a no-op (`unchanged`). The next run finishes what the journal says before it looks at a new request: up to `saving-previous` it starts the request over; at `swapping` it checks whether the target is already installed and either goes on to the health check or swaps again; at `restarting` it repeats the restart and the gate (so a previous binary with no result means "finish the health check or roll back"); at `rolling-back` it finishes the rollback, which is idempotent; at `finished` it only publishes the result.

**What is not part of this decision.** The host side (`Upkeep`, `RunGate`, the drain, writing the snapshot and the request, reading the result) is described in the amendment below. The helper only reads the snapshot when one exists.

## Alternatives considered

- **The host replaces its own binary.** It needs a writable binary and breaks the unit's hardening; a compromised host could persist across restarts.
- **A keeper daemon with a socket protocol.** A second long-running root process and a protocol to version; its own update would still need `install.sh`.
- **`sudo` or a setuid helper for the service user.** A wider interface than a file with a version in it, and `NoNewPrivileges=yes` forbids it.
- **Verifying with `openssl` as `install.sh` does.** The helper is part of the compiled host, so WebCrypto needs nothing installed beyond the host itself.

## Consequences

- Two more root-owned units and a root code path; its imports are limited to `platform/` and the contract by a dependency-cruiser rule (`update-helper-runs-as-root`), so no host server code runs as root.
- Root deletes `request.json` in a directory the service user owns. The service user can replace `updates/` with a link between the helper's directory check and the unlink, and then make root remove a file named `request.json` somewhere else; it cannot make root read or write anything else. Accepted: the name is fixed and the effect is a deleted file of that name.
- The helper trusts the installed binary to run `version`; a host older than this feature has no such command, so `install.sh` leaves the path unit off and says so.
- A host installed with `--url` has no release to update from: no `update.conf` and no units are written, and the host reports its updates as unmanaged.
- A failed update leaves the old binary running and the database as the drain left it; a failed rollback needs a person (`failed`).
- Verified 2026-11-19 by the VM smoke (`scripts/smoke-update-helper.sh`) under systemd 252 in an OrbStack Debian 12 machine: the path unit starts the helper, `runuser` and `systemctl` work under the helper unit's hardening, an update to a second version and a rollback succeed. Not verified on a full VM or a real server, where systemd credentials work (OrbStack needed a smoke-only drop-in, `docs/smoke.md`).

Amended 2026-11-19: the host reads `update.conf` too (it is world-readable) to know whether a helper exists and which feed it follows, and reports it as `HostStatus.update` (`upkeep`, read-only; no request is written yet). The parser moved to `platform/update-conf.ts`.

Amended 2026-11-19 (host side, ticket 13): the host acts on it. `Upkeep.run` takes one action (`check`, `apply` when idle or now, `cancel`, `auto`). An update when idle closes a `RunGate` (new messages are refused with "Updating, back in a minute", scheduled routines are not fired and follow `catchUp` afterwards) and waits for the running turns, fronts and headless runs to finish; a drain that passes 30 minutes stays a drain and offers Update now, which interrupts (a run left `running` is reported interrupted at the next start and never run again). Then, with the gate still closed, the host snapshots the database with `VACUUM INTO updates/pre-<version>.db` (older snapshots are deleted), remembers the request id in `updates/upkeep.json` and writes `request.json`. The helper's result becomes `current` or `failed`; a failure reopens the gate and stays (also across the restart a rollback causes) until the owner acknowledges it or updates again, and raises the `update-failed` host problem (banner and one channel message). Auto-update is a setting in the same file, off by default.

Amended 2026-11-19 (skip the rolled-back release, ticket 21): a rollback no longer turns automatic updates off. The host records the release it rolled back from (the `rolled-back` result's `from`, a version string and nothing else) as `skipped` in its own `updates/upkeep.json`, which survives the restart a rollback causes; the helper's layout is not involved. While the feed's newest release is that version the status is `current` with `skipped` set, so it is neither offered nor applied automatically; a newer release, or this host running it again, ends the skip. An explicit `apply` still installs it.

Amended 2026-11-19 (manual rollback, ticket 14): a rollback request may carry `"restoreSnapshot": true`, the owner's explicit confirmation that the database snapshot of the installed version (`updates/pre-<installed version>.db`) replaces the database along with the previous binary. It is a flag, not a path: the helper derives the one snapshot from its own layout with `snapshotName`, requires a regular file there, records the file name in its journal and restores it as the service user, as for an automatic rollback. Without the flag a rollback is refused when the previous binary's schema is older than the database's (unchanged); with it, a rollback is refused when the previous binary can open the database (a restore would only lose changes) or when no snapshot exists. `restoreSnapshot` is the literal `true` or absent, so `false` is an invalid request. A `rolled-back` result says whether the snapshot was restored (`snapshotRestored`). Every result already carried `running` and `previous` (`{version, schemaVersion}` read with each binary's `version` subcommand); the host uses them, not `release.json`, to decide whether to offer a rollback, so the offer and the helper's refusal come from the same facts. The host drains (`RunGate`) before it writes a rollback request exactly as for an update, takes no new snapshot (it would delete the one a restore needs) and turns automatic updates off.
