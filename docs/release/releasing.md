# Releasing

A release is triggered by pushing a `v*` tag, which runs `.github/workflows/release.yml`.

Related docs:

- Ed25519 release signing & key setup: [`signing.md`](signing.md)
- Local macOS signing & notarization: [`local-signing.md`](local-signing.md)
- Local macOS release dry run: [`local-release.md`](local-release.md)

## Cutting a release

The single source of truth for version is `VERSION` in `packages/host/src/harness/claude-access.ts` (no `package.json` carries a version).

1. Set `VERSION` without the leading `v` (e.g. `0.2.0` or `0.2.0-rc.1`).
2. For a stable release, preview generated notes and move `[Unreleased]` into `## [<version>] - <date>` in `CHANGELOG.md`:

   ```sh
   gh api repos/{owner}/{repo}/releases/generate-notes -f tag_name=v0.2.0 -f target_commitish=master -q .body
   ```

3. Run `bun run check`, commit, and merge to the default branch.
4. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
   - `verify` fails before building if the tag disagrees with `VERSION` or if `RELEASE_SIGNING_KEY` / the pinned key in `deploy/install.sh` is missing.
5. Verify the published release offline:

   ```sh
   gh release download v0.2.0 -R OWNER/REPO -D /tmp/release-check
   bun scripts/release.ts verify-release /tmp/release-check 0.2.0
   ```

## Workflow pipeline

1. `verify`: checks tag vs `VERSION` (`scripts/release.ts tag`), Ed25519 signing readiness (`release.ts signing-ready`), and platform signing plan (`scripts/signing.ts plan`).
2. `host`: builds all five host binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`) on native runners, signs macOS/Windows binaries when secrets exist, runs `smoke:host`, and uploads `release-host-<target>`. (`ubuntu-24.04-arm` is free for public repos only; on Windows `smoke:host` terminates instead of SIGTERM and skips graceful-exit/lock checks.)
3. `desktop`: packages installers (`SUPPORTED_DESKTOP` in `scripts/desktop-kit.ts`: macOS arm64+x64 dmg/zip, Windows x64 NSIS, Linux x64 AppImage/deb; linux-arm64 and windows-arm64 are host-only) around the `host` job's binaries (`--host-dir`), verifies byte-identity of the bundled host (`scripts/release.ts desktop`), verifies code signatures (`scripts/signing.ts verify`), and uploads `release-desktop-<os>`. macOS arm64 and x64 run in one job so electron-builder writes one `latest-mac.yml` listing both zips.
4. `publish`: merges `release-*` artifacts, generates `release.json`, `SHA256SUMS`, and `SHA256SUMS.sig`, runs `verify-release`, and creates/updates the GitHub Release (draft until all assets upload; pre-release suffix sets pre-release).

Local release helpers:

- `bun scripts/release.ts tag v0.2.0`
- `bun scripts/release.ts desktop <bundleDir> <hostDir> <outDir> <version> <arch>…`
- `bun scripts/release.ts checksums <folder> <version> [--only <target>…]`
- `bun scripts/release.ts verify-release <folder> <version> [--only <target>…]`

`--only` narrows required installers for local dry runs and prints `PARTIAL`; CI never passes it.

## Code signing and notarization

Signing runs only when all of a platform's secrets are set (all-or-nothing; a partial set fails `verify`). Without secrets, builds stay unsigned and the job summary marks them `UNSIGNED`. Linux packages are never signed.

Set the repository **variable** `TOMTE_REQUIRE_SIGNING=true` (`gh variable set TOMTE_REQUIRE_SIGNING --body true`) to fail closed whenever macOS or Windows signing secrets are missing.

### Repository secrets

| Secret                         | Content                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`        | base64 of Developer ID Application `.p12` with private key (must hold exactly one identity) |
| `MACOS_CERTIFICATE_PASSWORD`   | `.p12` password                                                                             |
| `APPLE_API_KEY_P8`             | App Store Connect API key (`AuthKey_<id>.p8`) for `notarytool`                              |
| `APPLE_API_KEY_ID`             | Key ID                                                                                      |
| `APPLE_API_ISSUER`             | Issuer ID                                                                                   |
| `WINDOWS_CERTIFICATE_PFX`      | base64 of code signing `.pfx` with private key                                              |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` password                                                                             |

### Non-obvious signing invariants

- **Host byte-identity**: `host` signs `tomte-host` before `smoke:host`; `desktop` excludes it from re-signing (`mac.signIgnore` on macOS, `!tomte-host.exe` in `SIGNED_WIN.signExts` on Windows) so `release.ts desktop` sees byte-identical binaries.
- **Windows `SIGNED_WIN.signExts`**: `[".dll", "!tomte-host.exe"]`. Never add a positive `.exe` pattern—positive matches override `!` and re-sign `tomte-host.exe`.
- **macOS entitlements**: `scripts/entitlements.mac.plist` (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` for Chrome's Google-signed Widevine CDM) and `MAC_ENTITLEMENT_KEYS` in `scripts/signing-kit.ts` must move together.
- **Bundled browser**: `scripts/mac-verify.ts` and `scripts/win-verify.ts` verify `agent-browser` and Chrome binaries/helpers/dylibs/DLLs inside both the unpacked app and the macOS update zip. `scripts/signing.ts sign-host` refuses to run outside GitHub Actions.
- **Local macOS signing**: use `bun run sign:local plan|run|cleanup` (see [`local-signing.md`](local-signing.md)); never mix `--local-keychain` with CI's `CSC_LINK`.

### One-time human setup

1. **macOS**: create a Developer ID Application cert, export `.p12` with private key, create an App Store Connect team API key (Developer role or higher), download `.p8`, and note Key ID + Issuer ID.
2. **Windows**: obtain a code signing cert exportable as `.pfx`. Note: post-June 2023 CA/Browser Forum rules generally require HSM/hardware tokens for new certs; if unexportable, update `signHostWindows` in `scripts/signing.ts` and `SIGNED_WIN` in `scripts/package-desktop.ts` for cloud/Azure Trusted Signing before setting secrets.
3. Upload secrets via `gh secret set`, delete local exports, cut a pre-release (`v0.2.0-rc.1`), confirm `verify` reports signed, verify on clean macOS (`spctl --assess --type execute --verbose=4 /Applications/Tomte.app`, `xcrun stapler validate`) and Windows (`Get-AuthenticodeSignature`), then set `TOMTE_REQUIRE_SIGNING=true`.
