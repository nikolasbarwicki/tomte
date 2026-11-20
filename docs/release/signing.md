# Signed releases

Every release publishes `SHA256SUMS`, an Ed25519 signature of it (`SHA256SUMS.sig`) and `release.json`. A server checks the signature with a public key it already holds, so it does not have to trust the channel that delivered the files (GitHub, a mirror, a proxy). Spec: `.scratch/client-host-split/spec.md`, decisions 3 and 8; ticket 10.

| File             | What it is                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHA256SUMS`     | `sha256sum` lines for every other published file, `SHA256SUMS.sig` excepted.                                                                                                                                                                                         |
| `SHA256SUMS.sig` | The raw 64-byte Ed25519 signature of the exact bytes of `SHA256SUMS`. Binary, no armor.                                                                                                                                                                              |
| `release.json`   | `{ "version", "shellApi": { "min", "max" }, "schemaVersion" }` (`ReleaseManifest`, `packages/contract/src/api.ts`). Listed in `SHA256SUMS`, so the signature covers it. `shellApi` is the release host's `SHELL_API`, `schemaVersion` its database `SCHEMA_VERSION`. |

The key pair is the owner's. The private key is the repository secret `RELEASE_SIGNING_KEY`. The public key is pinned in the repository as the `RELEASE_PUBLIC_KEY="…"` line of `deploy/install.sh`: base64 of the 32 raw public key bytes. Nothing a download or a config file says can replace it (no trust on first use).

## One-time setup (a person does this; no script can)

The owner's public key is pinned in `deploy/install.sh` (steps 1 and 3 below, done 2026-11-20); the private key's repository secret (step 2) is set apart from the repository. While the pin is empty, as it was before, `install.sh` refuses to install from a release, `bun scripts/release.ts verify-release` refuses, and the release workflow fails in its `verify` job, before anything is built.

1. Generate the key pair on a machine you trust (OpenSSL 3 or newer; on a Mac, `brew install openssl` and use that `openssl`, not the system LibreSSL):

   ```sh
   openssl genpkey -algorithm ed25519 -out release-signing.pem
   openssl pkey -in release-signing.pem -pubout -outform DER | tail -c 32 | base64
   ```

   The second command prints the public key: 44 characters ending in `=`.

2. Store the private key as the repository secret, then move the file somewhere safe (a password manager) and delete the local copy. Losing it means a key rotation (below); leaking it lets anyone sign a release your servers accept.

   ```sh
   gh secret set RELEASE_SIGNING_KEY < release-signing.pem
   ```

3. Pin the public key: put the printed value between the quotes of `RELEASE_PUBLIC_KEY="…"` in `deploy/install.sh` (replacing the old value on a rotation), run `bun run check`, commit and merge.
4. Check the setup before tagging: `RELEASE_SIGNING_KEY_SET=set bun scripts/release.ts signing-ready` exits 0 once the pin is a valid key. That the secret really is this key's pair is checked by the release itself (below).
5. Cut a pre-release (`v0.2.0-rc.1`, AGENTS.md "Releasing"), download it with `gh release download v0.2.0-rc.1 -R OWNER/REPO -D <dir>` and run `bun scripts/release.ts verify-release <dir> 0.2.0-rc.1`.

## What the release workflow does

- `verify` runs `release.ts signing-ready`: it fails unless the pin is a valid key and the secret exists (only whether it is set reaches the step).
- `publish` writes `release.json` (`release.ts manifest`), writes `SHA256SUMS` over every file including it (`checksums`), signs it (`sign`, the only step that sees the secret) and checks the finished folder with `verify-release`. `sign` verifies its own signature against the pinned key before writing it, so a secret that is not the pinned key's pair fails the release instead of shipping sums no server accepts. A release without the secret never reaches `gh release create`.
- Locally, without the secret, `sign <dir> --key-file <pem>` reads the private key from a file (never together with `$RELEASE_SIGNING_KEY`). `docs/release/local-release.md` is the whole dry run on a Mac.

## What a server does

`install.sh` has one verified-download routine, `download_verified_release <release url> <dest dir> <asset>...`. It downloads `SHA256SUMS` and `SHA256SUMS.sig`, verifies the signature against `RELEASE_PUBLIC_KEY` (`openssl pkeyutl -verify -rawin`, so OpenSSL 3 or newer), then downloads `release.json` and each asset and checks every one against the signed sums. It sets `$release_version` from `release.json` and dies on any mismatch, leaving the caller with nothing it may trust. `install.sh --version X` also refuses when `release.json` names another version. The routine is the only place `install.sh` obtains release bytes.

`source install.sh` defines the routine and runs nothing else, so the root update helper (ticket 12) reuses it as is, and `scripts/install-verify.test.ts` calls it that way. The helper, being TypeScript inside the host binary, can instead implement the same format with WebCrypto: `crypto.subtle.importKey("raw", publicKey, "Ed25519", …)` then `verify("Ed25519", key, signature, sums)`, using the same pinned value.

`--url` and `--sha256` stay what they were: a file you vouch for yourself, with no signature involved.

## Limits and rotation

- A signature does not say which release is newest. Whoever controls the download channel can serve an older, validly signed release in place of `latest`. Ask for a version (`--version`) when that matters.
- Rotating the key means: generate a new pair, replace the secret, change the pin in `deploy/install.sh` and release. A server verifies new releases with whatever key its installed `install.sh`/update configuration pins, so servers that pinned the old key must be reinstalled with the new `install.sh`. There is no automatic rotation.
- Tests use a throwaway key generated in a temp directory (`scripts/release-test-kit.ts`). No key is ever committed.
