# A local release dry run (macOS arm64)

This builds, on one Mac and without GitHub Actions, the release folder the `publish` job would upload, as far as this Mac can build it, and checks it with `bun scripts/release.ts verify-release`. The macOS arm64 app comes out signed, notarized and stapled. The other four host binaries are built here. Every other OS's installer is left out, and `--only darwin-arm64` tells `checksums` and `verify-release` that it is missing on purpose. The result is a **partial** release: never publish it. Nothing here pushes, tags or uploads anything except the notary submissions of `sign-local`.

Run it yourself, from the repository root, in a terminal where `CI` is not set (`sign-local` refuses to run in CI).

## Before the first run

1. The release key pair (`docs/release/signing.md`, "One-time setup", steps 1 and 3): its public key is pinned in `deploy/install.sh` (`RELEASE_PUBLIC_KEY`), and you hold the private key's `.pem`. `sign` refuses a key that is not the pinned key's pair. Keep the `.pem` outside the repository; `--key-file` reads it from wherever it lives.
2. The macOS signing inputs of `docs/release/local-signing.md` ("Prerequisites"): the Developer ID Application `.p12`, its password, and either an App Store Connect API key or an `asc` profile, all named in `TOMTE_LOCAL_*` environment variables.
3. `bun install`, and network access (the notary service; the Bun runtimes that `build:host` cross-compiles against).
4. A shell where `CI` is unset (`unset CI`): `sign-local` refuses to run in CI.

## Commands

```sh
O=dist/rel-local-1          # a new folder per run; sign-local refuses an $O/mac that is not empty
V=0.1.0                     # the host's VERSION (packages/host/src/harness/claude-access.ts)
R=$O/release

# 1. The signed, notarized macOS arm64 app, DMG, update zip and signed host (docs/release/local-signing.md)
bun scripts/sign-local.ts plan --out $O/mac
bun scripts/sign-local.ts run  --out $O/mac --confirm-keychain-and-notary-upload

# 2. The other four host binaries. Run this after sign-local: its own step empties dist/host.
bun run build:host darwin-x64 linux-x64 linux-arm64 windows-x64

# 3. The release folder, as the publish job assembles it
mkdir -p $R
cp dist/host/tomte-host-{darwin-x64,linux-x64,linux-arm64,windows-x64.exe} $R/
cp $O/mac/host/tomte-host-darwin-arm64 $R/
cp $O/mac/artifacts/{Tomte-$V-arm64.dmg,Tomte-$V-arm64-mac.zip,Tomte-$V-arm64-mac.zip.blockmap,latest-mac.yml} $R/
sed 's|^DEFAULT_REPO=""$|DEFAULT_REPO="nikolasbarwicki/tomte"|' deploy/install.sh >$R/install.sh
cp deploy/tomte.service $R/
bun scripts/third-party-licenses.ts $R
bun scripts/release.ts manifest $R $V

# 4. Checksums, the Ed25519 signature and the offline check
bun scripts/release.ts checksums $R $V --only darwin-arm64
bun scripts/release.ts sign $R --key-file <path to your release-signing.pem>
bun scripts/release.ts verify-release $R $V --only darwin-arm64

# 5. The Apple side, and the signed app actually starting
spctl --assess --type execute --verbose=4 $O/mac/Tomte-darwin-arm64/mac-arm64/Tomte.app
xcrun stapler validate $R/Tomte-$V-arm64.dmg
codesign -dvv $R/tomte-host-darwin-arm64
bun run smoke:desktop $O/mac/Tomte-darwin-arm64/mac-arm64/Tomte.app
```

Do not copy `$O/mac/artifacts/SHA256SUMS` into `$R`: it covers only the macOS files, lacks `release.json` and is not signed. Step 4 writes the release's own. Leave out `NOTARIZATION.json` too; it is a record of the run, not a release asset.

`verify-release` ends with `… is a complete, consistent PARTIAL (installers: darwin-arm64) release 0.1.0`, and both `checksums` and `verify-release` print a `PARTIAL:` line first. Without `--only` the same folder fails, naming the Windows, Linux and macOS x64 installers it lacks. That is the check a published release gets.

`sign` failing with `the release signing key does not belong to the public key pinned in deploy/install.sh` means the `.pem` is not the private half of the pinned `RELEASE_PUBLIC_KEY`; nothing is written. Point `--key-file` at the right file. Do not change the pin to make a run pass.

`sign-local` checks that the host inside the app is byte for byte its own signed copy, `$O/mac/host/tomte-host-darwin-arm64` (the file step 3 puts in the release folder), and verifies the app's, the host's and the bundled browser's signatures. `smoke:desktop` is what shows the signed host, the browser engine and Chrome start under the hardened runtime (`docs/release/local-signing.md`, "Known limits").

## How this differs from the published release

- Only the macOS arm64 installer is built and signed. `sign-local` is arm64-only; the Windows and Linux installers are built only by the workflow.
- `tomte-host-darwin-x64` is not signed (in CI the host job signs it), and the other host binaries are cross-compiled here instead of on native runners, where the host job also runs `smoke:host` on each.
- The app's update feed is the local placeholder `https://updates.invalid/tomte`, because `GITHUB_REPOSITORY` is not set, so the app never updates itself.
- The DMG is stapled, so it has no `.blockmap` (`verify-release` accepts that; CI's unstapled DMG carries one). The files are not byte-identical to a CI build.
