# Local macOS signing and notarization (personal test builds)

`bun scripts/sign-local.ts` (alias `bun run sign:local`) signs and notarizes an **arm64** Claudebot build on this Mac, with a Developer ID Application certificate and an App Store Connect API key that you hold. It produces a signed, notarized, stapled DMG, a signed update zip and a signed bundled host. Nothing is installed, published or pushed.

It is a separate route from the release workflow. CI keeps using `scripts/signing.ts` and `package-desktop.ts --sign` with the `CSC_LINK` secrets exactly as before (AGENTS.md, "Signing and notarization"); this route never runs in CI and refuses when `CI` is set.

**Status: built and tested against fakes, never run for real.** No command in this guide has been executed against a real keychain, certificate or Apple service by the people who wrote it. "Verified" below means "read from the source of the tool or its manual page", not "observed".

## Commands

```sh
bun scripts/sign-local.ts plan    --out dist/rel-ready-1108-signed-arm64                       # default; runs nothing
bun scripts/sign-local.ts run     --out dist/rel-ready-1108-signed-arm64 --confirm-keychain-and-notary-upload
bun scripts/sign-local.ts cleanup --out dist/rel-ready-1108-signed-arm64                       # only after a run was killed hard
```

Other flags: `--version <semver>` (default: the host's `VERSION`), `--arch arm64` (the only accepted value) and `--add-to-search-list` (below).

- `plan` prints every operation in order with its arguments (secrets as `<labels>`), every path, the identity rule, the global settings the route touches and the secrets that appear on a command line. It runs no command, reads no file and does not look at the keychain. It also lists what would make `run` refuse right now.
- `run` does the work. It refuses, before running anything, when `CI` is set, when `--confirm-keychain-and-notary-upload` is missing, when this is not macOS, when an input is missing or names no file, when `--out` exists and is not empty, when a process runs from under `--out`, or when `--out` lies in a `Keychains` folder.
- `--out` must not exist (or be empty). Use a new folder per run.

## Prerequisites (a person has to provide these)

1. A **Developer ID Application** certificate with its private key, exported from Keychain Access as a `.p12` that also contains the **intermediate** certificate ("Developer ID Certification Authority") if you can include it, with a password. Exactly one valid Developer ID Application identity must be in it.
2. An App Store Connect **team API key** (`AuthKey_<id>.p8`), its Key ID and the Issuer ID (Users and Access, Integrations, Team Keys; Developer role or higher).
3. Xcode command line tools (`xcrun notarytool`, `xcrun stapler`, `codesign`, `security`, `ditto`, `hdiutil`), network access, and the repository's own dependencies (`bun install`).
4. Your explicit decision to let the route create a temporary keychain, upload to Apple's notary service and (optionally) change the keychain search list.

Credentials come **only** from these environment variables. The CI secret names (`MACOS_CERTIFICATE_P12`, …) are deliberately not accepted: they hold base64 contents, these hold paths.

| Variable                                                              | Content                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CLAUDEBOT_LOCAL_P12_FILE`                                            | absolute path of the `.p12`                                                          |
| `CLAUDEBOT_LOCAL_P12_PASSWORD_FILE` or `CLAUDEBOT_LOCAL_P12_PASSWORD` | exactly one: a file holding the password (trailing newline ignored), or the password |
| `CLAUDEBOT_LOCAL_API_KEY_FILE`                                        | absolute path of the `.p8`                                                           |
| `CLAUDEBOT_LOCAL_API_KEY_ID`                                          | the key's Key ID                                                                     |
| `CLAUDEBOT_LOCAL_API_ISSUER`                                          | the issuer ID                                                                        |

`sign-local.ts` reads them once and removes them from its own environment, so the build, electron-builder and `notarytool` never inherit them. The `.p8` path is handed on as `APPLE_API_KEY`, the key ID and issuer as `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, which is what `@electron/notarize` reads. Prefer `…_PASSWORD_FILE` so the password is not in your shell's environment or history.

## What `run` does

All state lives inside `--out`:

```
<out>/.signing/<run-id>.keychain-db   the temporary keychain (deleted at the end)
<out>/.signing/state.json             run id, pid, keychain path, search-list snapshot (for cleanup)
<out>/host/claudebot-host-darwin-arm64    the signed host (what package:desktop bundles)
<out>/Claudebot-darwin-arm64/             electron-builder's output: unpacked app, DMG, update zip, blockmaps, latest-mac.yml
<out>/artifacts/                          the finished DMG, zip, blockmaps, latest-mac.yml and SHA256SUMS
```

Order (the exact argv is what `plan` prints): create the folders and state file; snapshot the user search list (read only); `build-host.ts darwin-arm64`; copy the host into `<out>/host`; create, configure and unlock the temporary keychain; import the `.p12` (`-T /usr/bin/codesign`) and set the key partition list; optionally prepend the keychain to the search list; select the one identity by SHA-1; sign the host (hardened runtime, secure timestamp, `scripts/entitlements.mac.plist`) and verify it; run `package-desktop.ts --sign --local-keychain … --local-identity <sha1>` (electron-builder signs the app and notarizes and staples it, then builds the zip and the DMG); unlock again; sign the DMG with a timestamp; **notarize the DMG** (`notarytool submit --wait`, the log is fetched on a rejection); staple it; rewrite the DMG's `sha512` and `size` in `latest-mac.yml`; verify the app, the app inside the zip and the DMG with the same checks CI uses (`scripts/mac-verify.ts`); check the host is byte-identical everywhere, that `latest-mac.yml` describes the zip and DMG on disk, and write `SHA256SUMS`. Always last: delete the keychain, take only our entry out of the search list, remove `<out>/.signing`.

### Identity selection

`security find-identity -v -p codesigning <temporary keychain>` must list exactly one valid "Developer ID Application" identity. It is then named to `codesign` and electron-builder by its SHA-1, never by name, always with `--keychain <temporary keychain>`. Zero or several fail the run.

### What is uploaded to Apple

1. `Claudebot.zip`: a `ditto` archive of the signed `Claudebot.app` (Electron frameworks and helpers, `app.asar`, the bundled signed host, resources), made by `@electron/notarize` in a temporary folder.
2. The signed DMG (the stapled app and the Applications link).

The update zip is not uploaded: it is built afterwards from the app whose ticket is already stapled. Apple sees the file names and contents of those two archives and your team's identity; nothing else of this machine.

## Global settings

|                                          |                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never touched                            | the login keychain, the default keychain, the System keychain, trust settings, login items, anything under `~/Library/Keychains`                                                                                                                                                                                                                                          |
| Possibly touched (UNVERIFIED)            | `security create-keychain` may list the new keychain in the user search list. The man page says only "Create keychains" and says `delete-keychain` "removes them from the search list". The route therefore never rewrites the list by default, takes a read-only snapshot before, and after `delete-keychain` removes our entry from the list only if it is still there. |
| Touched only with `--add-to-search-list` | the user search list: `list-keychains -d user -s <temporary keychain> <the snapshot>`. At the end only that entry is removed (a compare-and-swap against the snapshot: if the list changed meanwhile, the rest is kept and a warning is printed; between the read and the write another process could still change it, which no `security` command prevents).             |
| Outside `--out`                          | `dist/host` (`build:host` always empties and refills it) and electron-builder's download caches under `~/Library/Caches/electron-builder`.                                                                                                                                                                                                                                |

### Why `--add-to-search-list` exists (UNVERIFIED)

`codesign --keychain` restricts where the signing identity is looked up but, per its man page, "the standard keychain search path is still consulted while constructing the certificate chain". If the `.p12` does not carry the Developer ID intermediate and the intermediate is not in a keychain on the search path, `find-identity -v` may report no valid identity or `codesign` may fail to build the chain. Whether the temporary keychain itself must be on the search path for either is not established. Try without the flag first; the identity step names the flag when it finds no valid identity. Including the intermediate in the `.p12` is the first remedy.

### What electron-builder does with it (read from `app-builder-lib` 26.18.0 and `@electron/notarize` 2.5.0; UNVERIFIED at run time)

- With `CSC_LINK` set (CI) electron-builder creates its own keychain and prepends it, plus its root-certificates keychain, to the user search list and never restores the list. That is why this route does not use `CSC_LINK`.
- Without `CSC_LINK`, `CSC_KEYCHAIN` names the keychain and electron-builder creates none and does not change the search list. The identity is passed as the SHA-1 (`mac.identity`; electron-builder matches it against `security find-identity` output, so no `Developer ID Application:` prefix). `forceCodeSigning: true` is set so a missing identity fails instead of shipping an unsigned app.
- electron-builder notarizes the `.app` only (`ditto`, `notarytool submit --wait`, `stapler staple`). It does **not** notarize or staple the DMG, and it signs a DMG only when `dmg.sign` is set, without a timestamp. This route signs, notarizes and staples the DMG itself.
- Stapling changes the DMG's bytes, so electron-builder's `latest-mac.yml` entry for the DMG (and its `.blockmap`) go stale. The route rewrites the entry's `sha512` and `size`. **The DMG's `blockMapSize` and the `.blockmap` stay stale.** electron-updater applies the zip on macOS, not the DMG, so this should not matter for updates (UNVERIFIED).

## Secrets on command lines

A secret on a command line is visible to the same user's `ps` while it runs. These are unavoidable with the tools involved:

| Command                                                                          | Secret                                                                                             | For how long                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `security import -P`                                                             | the `.p12` password                                                                                | about a second                        |
| `security create-keychain -p`, `unlock-keychain -p`, `set-key-partition-list -k` | the keychain's random password (24 random bytes, never stored; the keychain is deleted at the end) | each under a second, twice for unlock |
| `xcrun notarytool submit --key-id --issuer`                                      | the API key ID and issuer (not the key; the `.p8` is passed as a path)                             | the length of the notarization        |

The plan, logs, warnings and errors never contain a secret value: secrets are `Secret` objects that print as `<label>`, and `CommandError` messages name only a command's first two words. The `.p12` and `.p8` contents are never on a command line.

## Failure, signals and cleanup

- A failing step stops the run and cleans up: `delete-keychain`, remove our search-list entry if it is still listed, remove `<out>/.signing`. `<out>` itself and the electron-builder output are kept for inspection.
- SIGINT and SIGTERM stop the running command, run the same cleanup and exit 130.
- SIGKILL, a crash or a power loss cannot be cleaned up in-process. The keychain file is then left in `<out>/.signing` (its password is lost with the process), together with `state.json`. Run `bun scripts/sign-local.ts cleanup --out <out>`: it deletes the keychains found there, removes our entry from the search list if the state file records a snapshot and it is still listed, and removes `.signing`. The state file's keychain must lie directly inside `<out>/.signing`, so a damaged file cannot make `cleanup` delete anything elsewhere. It is safe to run twice.

## Verifying a result by hand

```sh
spctl --assess --type execute --verbose=4 <out>/Claudebot-darwin-arm64/mac-arm64/Claudebot.app
xcrun stapler validate <out>/Claudebot-darwin-arm64/mac-arm64/Claudebot.app
spctl -a -t open --context context:primary-signature -vv <out>/artifacts/Claudebot-<version>-arm64.dmg
xcrun stapler validate <out>/artifacts/Claudebot-<version>-arm64.dmg
codesign -dvv <out>/Claudebot-darwin-arm64/mac-arm64/Claudebot.app/Contents/Resources/claudebot-host
(cd <out>/artifacts && shasum -a 256 -c SHA256SUMS)
```

The route runs the same checks itself. For a download-like test, copy the DMG through a browser or `xattr -w com.apple.quarantine "0081;00000000;Safari;" <dmg>` on a scratch copy, then open it.

## Known limits

- arm64 only; Windows and Linux are untouched.
- The personal build bakes the placeholder update feed (`https://updates.invalid/claudebot`) unless `GITHUB_REPOSITORY` is set: it will never auto-update. That is intended for a test build.
- The `.dmg`/`.zip` produced here are not byte-identical to a CI release and are not for publishing.
- Whether the Bun-compiled host runs under the hardened runtime with only the JIT entitlements (`scripts/entitlements.mac.plist`) is unobserved. The host job's smoke on a signed host exists in CI for this; this route does not start the host. If a signed host fails to start, add the entitlement to the plist and `HOST_ENTITLEMENTS` in `signing-kit.ts`.
- Whether DMG notarization with a timestamp-only `codesign --force --timestamp` (no hardened runtime, as for any DMG) is accepted by Apple is unobserved; the route fails with Apple's log when it is not.

## What is verified

|                                                                                                                                                                                                                 | Status                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Operation order, arguments, redaction, refusals, cleanup (failure, SIGTERM, crash), search-list restore, identity rule, DMG sign, notarize, staple, `latest-mac.yml` rewrite, verification, artifact collection | **Tested against a recording fake** (`scripts/local-signing.test.ts`) |
| CI verification unchanged by the refactor (`scripts/mac-verify.test.ts` pins the old argv sequence)                                                                                                             | **Tested**                                                            |
| `security`, `codesign`, `notarytool`, `stapler`, `spctl` behavior; electron-builder keychain handling; Apple accepting the DMG                                                                                  | **Unobserved**: read from man pages and `node_modules` source only    |
