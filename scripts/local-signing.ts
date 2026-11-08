// The local macOS signing route: the ordered operation list, its executor and its cleanup (docs/release/local-signing.md).
// One list serves both `plan` (prints it, runs nothing) and `run` (executes it), so the plan cannot drift from what runs.
// Every external command goes through the injected {@link Runner}; tests pass a recording fake.
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  type AscNotary,
  appZipArgv,
  ascLogArgv,
  ascSubmitArgv,
  type NotarySubmission,
  notarizeWithAsc,
  readSubmissionRecord,
} from "./asc-notary.ts";
import { CommandError, type Ran, type Runner } from "./command-runner.ts";
import { collectDesktopRelease, hostBinaryName } from "./desktop-kit.ts";
import {
  type Arg,
  type LocalConfig,
  type LocalSecrets,
  type LocalState,
  LOCAL_ENV,
  parseKeychainList,
  parseNotarySubmission,
  parseState,
  replaceUpdateFile,
  reveal,
  Secret,
  serializeState,
  show,
  withoutKeychain,
} from "./local-signing-kit.ts";
import { dmgCommands, macAppCommands, verifyDmg, verifyMacBundle } from "./mac-verify.ts";
import { type ProcessRow, processesUnder, refusal } from "./process-guard.ts";
import { sha256, writeChecksums } from "./release-kit.ts";
import { sha512Base64, parseUpdateMetadata } from "./release-verify.ts";
import { parseDeveloperIdIdentity } from "./signing-kit.ts";

export interface Deps {
  run: Runner;
  log: (line: string) => void;
  warn: (line: string) => void;
  processes: () => ProcessRow[];
  /** Calls `handler` on SIGINT or SIGTERM; the returned function stops listening. */
  onSignal: (handler: () => void) => () => void;
  /** Stops commands this process started and is still waiting for. */
  stopCommands: () => void;
  exit: (code: number) => void;
}

/** What the steps pass to each other. */
interface Ctx {
  config: LocalConfig;
  /** SHA-1 of the one Developer ID Application identity in the temporary keychain; known after the `find-identity` step. */
  identity: string;
  teamId: string;
  state: LocalState;
  /** Every notarization of the run so far, in order; `NOTARIZATION.json` and the final report list them. */
  submissions: NotarySubmission[];
}

const IDENTITY_PLACEHOLDER = "<identity-sha1>";

/** A command as the plan prints it: secrets as labels, an argument with a space (a profile name) in quotes. */
const line = (args: readonly Arg[]) =>
  args
    .map((a) => show(a))
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ");

interface StepBase {
  title: string;
  /** What outside `--out` the step changes ("nothing" for most). */
  touches: string;
  /** Only with `--add-to-search-list`. */
  optIn?: boolean;
  /** What a tool the step starts does inside it, read from that tool's source and not yet observed. */
  nested?: readonly string[];
}

type Step = StepBase &
  (
    | {
        kind: "command";
        argv: (c: Ctx) => Arg[];
        env?: (c: Ctx) => Record<string, Arg>;
        after?: (c: Ctx, ran: Ran, d: Deps) => void | Promise<void>;
      }
    | {
        kind: "internal";
        /** The commands it runs, for the plan; empty when it only works on files. */
        commands: (c: Ctx) => Arg[][];
        run: (c: Ctx, d: Deps) => Promise<void>;
      }
  );

/** Keychain lock timeout in seconds (`set-keychain-settings -lut`): long enough for the app's signing, re-unlocked before the DMG. */
const KEYCHAIN_TIMEOUT = "1800";

const unlockArgv = (c: Ctx): Arg[] => [
  "security",
  "unlock-keychain",
  "-p",
  c.config.secrets.keychainPassword,
  c.config.paths.keychain,
];

/** The arguments that name the App Store Connect API key to `notarytool`. */
const notaryAuth = (c: Ctx): Arg[] => [
  "--key",
  c.config.inputs.apiKeyFile ?? `<${LOCAL_ENV.apiKeyFile}>`,
  "--key-id",
  c.config.secrets.apiKeyId,
  "--issuer",
  c.config.secrets.apiIssuer,
];

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeState(c: Ctx): Promise<void> {
  await writeFile(c.config.paths.state, serializeState(c.state), { mode: 0o600 });
}

/** The asc profile of the run, `undefined` for the `notarytool` backend. */
const ascOf = (c: Ctx): AscNotary | undefined =>
  c.config.notary.kind === "asc"
    ? { bin: c.config.notary.bin, profile: c.config.notary.profile }
    : undefined;

/** Notarizes the signed DMG; on a rejection, includes Apple's log (no credentials in it) in the error. */
async function notarizeDmg(c: Ctx, d: Deps): Promise<void> {
  const asc = ascOf(c);
  if (asc !== undefined) {
    c.submissions.push(
      await notarizeWithAsc({ run: d.run, asc, file: c.config.paths.dmg, kind: "dmg", log: d.log }),
    );
    return;
  }
  const submit = ["xcrun", "notarytool", "submit", c.config.paths.dmg, ...notaryAuth(c)];
  const args = [...submit, "--wait", "--output-format", "json"];
  let ran: Ran;
  try {
    ran = await d.run(args.map(reveal));
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    const { id } = parseNotarySubmission(error.stdout);
    const log =
      id === undefined
        ? ""
        : await d
            .run(["xcrun", "notarytool", "log", id, ...notaryAuth(c)].map(reveal))
            .then((r) => `\n${r.stdout.trim()}`)
            .catch(() => "");
    throw new Error(`notarizing ${c.config.paths.dmg} failed: ${error.message}${log}`);
  }
  const { id, status } = parseNotarySubmission(ran.stdout);
  if (status !== "Accepted") {
    throw new Error(
      `notarizing ${c.config.paths.dmg}: status ${status ?? "(unreadable)"}, submission ${id ?? "(none)"}`,
    );
  }
  d.log(`notarized ${c.config.paths.dmg} (submission ${id})`);
  c.submissions.push({
    kind: "dmg",
    file: basename(c.config.paths.dmg),
    sha256: await sha256(c.config.paths.dmg),
    id,
    status,
  });
}

/** Reads the app's submission that the asc backend's packaging run left behind, and reports it. */
async function collectAppSubmission(c: Ctx, d: Deps): Promise<void> {
  const submission = await readSubmissionRecord(c.config.paths.appSubmission);
  c.submissions.push(submission);
  d.log(`app notarized: submission ${submission.id ?? "(unreadable)"}, ${submission.status}`);
}

/** NOTARIZATION.json: what was uploaded and what Apple answered; no secret in it. */
async function writeNotarization(c: Ctx): Promise<void> {
  const notary = c.config.notary;
  await writeFile(
    c.config.paths.notarization,
    `${JSON.stringify(
      {
        backend: notary.kind === "asc" ? "asc" : "notarytool",
        ...(notary.kind === "asc" ? { profile: notary.profile } : {}),
        version: c.config.version,
        submissions: c.submissions,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * After stapling the DMG its bytes are not what electron-builder hashed: `latest-mac.yml` must name the stapled file, and
 * the DMG's `.blockmap` (built from the old bytes) is deleted so it can never be collected or checksummed as verified.
 */
async function rewriteDmgMetadata(c: Ctx): Promise<void> {
  const p = c.config.paths;
  const text = await readFile(p.metadata, "utf8");
  const url = p.dmg.slice(p.bundleDir.length + 1);
  const size = (await stat(p.dmg)).size;
  await writeFile(
    p.metadata,
    replaceUpdateFile(text, url, { sha512: await sha512Base64(p.dmg), size }),
  );
  await rm(`${p.dmg}.blockmap`, { force: true });
}

/** Every file `latest-mac.yml` lists for the zip and the DMG exists with the sha512 and size it states. */
async function checkUpdateFiles(
  dir: string,
  metadata: string,
  names: readonly string[],
): Promise<void> {
  const meta = parseUpdateMetadata(await readFile(join(dir, metadata), "utf8"));
  for (const name of names) {
    const entry = meta.files.find((f) => f.url === name);
    if (entry === undefined) throw new Error(`${metadata} does not list ${name}`);
    const path = join(dir, name);
    if ((await stat(path)).size !== entry.size)
      throw new Error(`${metadata}: the size of ${name} is wrong`);
    if ((await sha512Base64(path)) !== entry.sha512)
      throw new Error(`${metadata}: the sha512 of ${name} is wrong`);
  }
}

async function collectArtifacts(c: Ctx): Promise<void> {
  const p = c.config.paths;
  const names = await collectDesktopRelease({
    bundleDir: p.bundleDir,
    hostDir: p.hostDir,
    outDir: p.artifacts,
    platform: "darwin",
    archs: ["arm64"],
    version: c.config.version,
  });
  const metadata = names.find((n) => n.endsWith(".yml")) as string;
  await checkUpdateFiles(
    p.artifacts,
    metadata,
    names.filter((n) => /\.(dmg|zip)$/.test(n)),
  );
  await writeChecksums(p.artifacts, names);
  await writeNotarization(c);
}

/** The ordered operations of one local signing run. */
function buildSteps(config: LocalConfig): Step[] {
  const p = config.paths;
  const p12 = config.inputs.p12File ?? `<${LOCAL_ENV.p12File}>`;
  const script = (name: string) => join(config.repoRoot, "scripts", name);
  return [
    {
      kind: "internal",
      title: "Create the staging folders and the state file",
      touches: `creates ${p.signingDir} (mode 0700, state.json) and ${p.hostDir}`,
      commands: () => [],
      run: async (c) => {
        await mkdir(p.signingDir, { recursive: true, mode: 0o700 });
        await mkdir(p.hostDir, { recursive: true });
        await writeState(c);
      },
    },
    {
      kind: "command",
      title: "Snapshot the user keychain search list (read only)",
      touches:
        "nothing; reads the list so a leftover entry of ours can be removed without touching anyone else's",
      argv: () => ["security", "list-keychains", "-d", "user"],
      after: async (c, ran) => {
        c.state.searchListBefore = parseKeychainList(ran.stdout);
        await writeState(c);
      },
    },
    {
      kind: "command",
      title: "Build the arm64 host",
      touches: `${join(config.repoRoot, "dist/host")} (build:host always empties and refills it)`,
      argv: () => ["bun", script("build-host.ts"), "darwin-arm64"],
    },
    {
      kind: "internal",
      title: "Stage a copy of the host to sign",
      touches: `creates ${p.stagedHost}`,
      commands: () => [],
      run: async () => {
        const built = join(config.repoRoot, "dist/host", hostBinaryName("darwin", "arm64"));
        await copyFile(built, p.stagedHost);
        await chmod(p.stagedHost, 0o755);
      },
    },
    {
      kind: "command",
      title: "Create the temporary keychain",
      touches: `creates ${p.keychain}; macOS may also list it in the user search list until it is deleted (UNVERIFIED)`,
      argv: (c) => [
        "security",
        "create-keychain",
        "-p",
        c.config.secrets.keychainPassword,
        p.keychain,
      ],
    },
    {
      kind: "command",
      title: "Lock the temporary keychain after 30 minutes and on sleep",
      touches: "the temporary keychain only",
      argv: () => ["security", "set-keychain-settings", "-lut", KEYCHAIN_TIMEOUT, p.keychain],
    },
    {
      kind: "command",
      title: "Unlock the temporary keychain",
      touches: "the temporary keychain only",
      argv: unlockArgv,
    },
    {
      kind: "command",
      title:
        "Import the certificate and its private key; /usr/bin/codesign is added to the key's ACL",
      touches:
        "the temporary keychain only; the .p12 password is on this command's argv for its duration",
      argv: (c) => [
        "security",
        "import",
        p12,
        "-k",
        p.keychain,
        "-f",
        "pkcs12",
        "-P",
        c.config.secrets.p12Password,
        "-T",
        "/usr/bin/codesign",
      ],
    },
    {
      kind: "command",
      title: "Let Apple-signed tools and apps and codesign use the key without a prompt",
      touches:
        "the key's partition list in the temporary keychain only (not codesign-only; see docs/release/local-signing.md)",
      argv: (c) => [
        "security",
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        c.config.secrets.keychainPassword,
        p.keychain,
      ],
    },
    {
      kind: "command",
      optIn: true,
      title: "Put the temporary keychain first in the user keychain search list (opt-in)",
      touches: "the user keychain search list; restored by removing only our entry",
      argv: (c) => [
        "security",
        "list-keychains",
        "-d",
        "user",
        "-s",
        p.keychain,
        ...(c.state.searchListBefore ?? ["<the search list read in step 2>"]),
      ],
    },
    {
      kind: "command",
      title: "Find the one Developer ID Application identity in the temporary keychain, by SHA-1",
      touches: "nothing; looks only in the temporary keychain",
      argv: () => ["security", "find-identity", "-v", "-p", "codesigning", p.keychain],
      after: (c, ran) => {
        try {
          c.identity = parseDeveloperIdIdentity(ran.stdout).hash;
        } catch (error) {
          const hint = config.addToSearchList
            ? ""
            : "; if the certificate is there but not valid, its intermediate may be missing from the keychains codesign searches: see --add-to-search-list in docs/release/local-signing.md";
          throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`);
        }
      },
    },
    {
      kind: "command",
      title: "Sign the staged host: hardened runtime, secure timestamp, entitlements",
      touches: `${p.stagedHost} only`,
      argv: (c) => [
        "codesign",
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        p.entitlements,
        "--keychain",
        p.keychain,
        "--sign",
        c.identity,
        p.stagedHost,
      ],
    },
    {
      kind: "command",
      title: "Verify the staged host's signature",
      touches: "nothing",
      argv: () => ["codesign", "--verify", "--strict", "--verbose=2", p.stagedHost],
    },
    {
      kind: "command",
      title:
        config.notary.kind === "asc"
          ? "Package and sign the app, notarize and staple it with asc (afterSign), then build the DMG and the update zip"
          : "Package, sign and notarize the app; build the DMG and the update zip",
      touches: `${p.bundleDir}; electron-builder's own caches under ~/Library/Caches/electron-builder (downloads, as for any build); uploads the app zip to Apple${config.notary.kind === "asc" ? `; leaves the app's submission in ${p.appSubmission}` : ""}`,
      nested: [
        "security find-identity -v <temporary keychain> (twice; lookups restricted to it)",
        "codesign --sign <identity SHA-1> --force --keychain <temporary keychain> --timestamp [--options runtime --entitlements ...] on every Mach-O in the app, then the app (@electron/osx-sign); the host is skipped (signIgnore)",
        ...(config.notary.kind === "asc"
          ? [
              "electron-builder's own notarization is off (notarize: false); its afterSign hook runs next, after signing and before the DMG and zip are built:",
              `${line(appZipArgv(p.app, "<tmp>/Claudebot.zip"))} (this zip is uploaded)`,
              `${line(ascSubmitArgv(config.notary, "<tmp>/Claudebot.zip"))}; on a rejection or an unreadable answer: ${line(ascLogArgv(config.notary, "<id>"))}`,
              `xcrun stapler staple ${p.app}`,
              `xcrun stapler validate ${p.app}`,
            ]
          : [
              "ditto -c -k --sequesterRsrc --keepParent Claudebot.app <tmp>/Claudebot.zip (this zip is uploaded)",
              "xcrun notarytool submit <tmp>/Claudebot.zip --key <api key> --key-id <id> --issuer <issuer> --wait --output-format json; xcrun notarytool log <id> on a rejection",
              "xcrun stapler staple -v Claudebot.app",
            ]),
        "hdiutil (builds the DMG from the stapled app), zip of the stapled app, blockmaps, latest-mac.yml",
      ],
      argv: (c) => [
        "bun",
        script("package-desktop.ts"),
        "--sign",
        "--arch",
        "arm64",
        "--out",
        p.out,
        "--version",
        config.version,
        "--host-dir",
        p.hostDir,
        "--local-keychain",
        p.keychain,
        "--local-identity",
        c.identity,
        ...(c.config.notary.kind === "asc"
          ? [
              "--local-notary",
              "asc",
              "--local-asc-profile",
              c.config.notary.profile,
              "--local-asc-bin",
              c.config.notary.bin,
              "--local-notary-record",
              p.appSubmission,
            ]
          : []),
      ],
      env: (c) =>
        c.config.notary.kind === "asc"
          ? {}
          : {
              APPLE_API_KEY: c.config.inputs.apiKeyFile ?? `<${LOCAL_ENV.apiKeyFile}>`,
              APPLE_API_KEY_ID: c.config.secrets.apiKeyId,
              APPLE_API_ISSUER: c.config.secrets.apiIssuer,
            },
      ...(config.notary.kind === "asc"
        ? { after: (c: Ctx, _ran: Ran, d: Deps) => collectAppSubmission(c, d) }
        : {}),
    },
    {
      kind: "command",
      title:
        "Unlock the temporary keychain again (it may have locked while Apple notarized the app)",
      touches: "the temporary keychain only",
      argv: unlockArgv,
    },
    {
      kind: "command",
      title: "Sign the DMG with a secure timestamp",
      touches: `${p.dmg}`,
      argv: (c) => [
        "codesign",
        "--force",
        "--timestamp",
        "--keychain",
        p.keychain,
        "--sign",
        c.identity,
        p.dmg,
      ],
    },
    {
      kind: "internal",
      title: "Notarize the DMG (uploads it to Apple)",
      touches: `uploads ${p.dmg} to Apple's notary service`,
      commands: (c) =>
        c.config.notary.kind === "asc"
          ? [ascSubmitArgv(c.config.notary, p.dmg)]
          : [
              [
                "xcrun",
                "notarytool",
                "submit",
                p.dmg,
                ...notaryAuth(c),
                "--wait",
                "--output-format",
                "json",
              ],
            ],
      run: notarizeDmg,
    },
    {
      kind: "command",
      title: "Staple the notarization ticket to the DMG",
      touches: `${p.dmg}`,
      argv: () => ["xcrun", "stapler", "staple", p.dmg],
    },
    {
      kind: "internal",
      title:
        "Rewrite the DMG's sha512 and size in latest-mac.yml, drop its blockMapSize and delete the DMG's stale .blockmap",
      touches: `${p.metadata}; deletes ${p.dmg}.blockmap (electron-builder made it before signing and stapling; it is not regenerated, so no artifact carries a stale one)`,
      commands: () => [],
      run: rewriteDmgMetadata,
    },
    {
      kind: "internal",
      title:
        "Verify the app and the app inside the update zip, host Team ID, hardened runtime, entitlements",
      touches: "a temporary folder (the zip is unpacked there and removed)",
      commands: () => [
        ...Object.values(macAppCommands(p.app)),
        ["ditto", "-x", "-k", p.zip, "<temporary folder>"],
        ...Object.values(macAppCommands("<temporary folder>/Claudebot.app")),
      ],
      run: async (c, d) => {
        const teams = await verifyMacBundle(d.run, p.bundleDir, config.version, ["arm64"], d.log);
        if (new Set(teams).size !== 1) {
          throw new Error(
            `the app and the app in the update zip have different Team IDs: ${teams.join(", ")}`,
          );
        }
        c.teamId = teams[0] as string;
      },
    },
    {
      kind: "internal",
      title: "Verify the DMG: Gatekeeper, stapled ticket, signature, same Team ID",
      touches: "nothing",
      commands: () => Object.values(dmgCommands(p.dmg)),
      run: (c, d) => verifyDmg(d.run, p.dmg, c.teamId, d.log),
    },
    {
      kind: "internal",
      title:
        "Check the host is the signed one everywhere, check latest-mac.yml, write SHA256SUMS and NOTARIZATION.json",
      touches: `creates ${p.artifacts}`,
      commands: () => [],
      run: (c) => collectArtifacts(c),
    },
  ];
}

/** Deletes a leftover temporary keychain, takes only our entry out of the search list, removes the signing folder. Safe to run twice. */
async function cleanupSigningDir(
  signingDir: string,
  state: LocalState | undefined,
  d: Deps,
): Promise<void> {
  const leftovers = (await exists(signingDir))
    ? (await readdir(signingDir))
        .filter((n) => n.endsWith(".keychain-db"))
        .map((n) => join(signingDir, n))
    : [];
  const keychains = new Set([...leftovers, ...(state === undefined ? [] : [state.keychain])]);
  for (const keychain of keychains) {
    if (await exists(keychain)) {
      await d.run(["security", "delete-keychain", keychain]).catch((e: Error) => {
        d.warn(`could not delete ${keychain}: ${e.message}`);
      });
    }
    if (state?.searchListBefore === undefined) continue;
    const current = parseKeychainList(
      (await d.run(["security", "list-keychains", "-d", "user"])).stdout,
    );
    const left = withoutKeychain(current, keychain, state.searchListBefore);
    if (left === undefined) continue;
    if (left.changed)
      d.warn(
        "the keychain search list changed while signing; removed only our entry and kept the rest",
      );
    await d.run(["security", "list-keychains", "-d", "user", "-s", ...left.list]);
  }
  await rm(signingDir, { recursive: true, force: true });
}

/** What `cleanup --out` does after a crash: reads the state file when there is one and cleans up what it and the folder show. */
export async function cleanupLocal(out: string, d: Deps): Promise<void> {
  const signingDir = join(out, ".signing");
  if (!(await exists(signingDir))) {
    d.log(`nothing to clean up: ${signingDir} does not exist`);
    return;
  }
  const statePath = join(signingDir, "state.json");
  const state = (await exists(statePath))
    ? parseState(await readFile(statePath, "utf8"), signingDir)
    : undefined;
  if (state === undefined)
    d.warn(
      `${statePath} is missing: deleting the keychains found in ${signingDir}, search list untouched`,
    );
  await cleanupSigningDir(signingDir, state, d);
  d.log(`cleaned up ${signingDir}`);
}

/** Reads the password and generates the keychain's: the only place a secret value is created. */
export async function loadSecrets(inputs: LocalConfig["inputs"]): Promise<LocalSecrets> {
  const password =
    inputs.p12PasswordFile === undefined
      ? (inputs.p12Password as string)
      : (await readFile(inputs.p12PasswordFile, "utf8")).replace(/\r?\n$/, "");
  return {
    keychainPassword: new Secret("keychain-password", randomBytes(24).toString("hex")),
    p12Password: new Secret("p12-password", password),
    apiKeyId: new Secret("api-key-id", inputs.apiKeyId ?? ""),
    apiIssuer: new Secret("api-issuer", inputs.apiIssuer ?? ""),
  };
}

/** Refusals that need the disk or the process table; the ones from the flags and the environment are `config.problems`. */
async function preflight(config: LocalConfig, d: Deps): Promise<void> {
  if (config.problems.length > 0) {
    throw new Error(`refusing to sign:\n- ${config.problems.join("\n- ")}`);
  }
  const p = config.paths;
  if ((await exists(p.out)) && (await readdir(p.out)).length > 0) {
    throw new Error(
      `refusing to sign: ${p.out} is not empty; the staging folder must be new (after a crash run \`cleanup --out ${p.out}\` first, then remove it)`,
    );
  }
  const running = processesUnder(p.out, d.processes());
  if (running.length > 0) throw new Error(refusal("sign into", p.out, running));
  const files =
    config.notary.kind === "asc"
      ? ([
          [LOCAL_ENV.p12File, config.inputs.p12File],
          // Only a path the user named is checked; a bare `asc` was resolved on PATH.
          ...(config.inputs.ascBin === undefined ? [] : [[LOCAL_ENV.ascBin, config.inputs.ascBin]]),
        ] as const)
      : ([
          [LOCAL_ENV.p12File, config.inputs.p12File],
          [LOCAL_ENV.apiKeyFile, config.inputs.apiKeyFile],
        ] as const);
  for (const [name, path] of files) {
    if (
      !(await stat(path as string).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new Error(`${name} does not name a file`);
    }
  }
}

/** Runs every step, then always cleans up; on SIGINT or SIGTERM it stops the running command, cleans up and exits 130. */
export async function runLocalSigning(config: LocalConfig, d: Deps): Promise<void> {
  await preflight(config, d);
  const ctx: Ctx = {
    config,
    identity: IDENTITY_PLACEHOLDER,
    teamId: "",
    submissions: [],
    state: {
      runId: config.runId,
      pid: process.pid,
      keychain: config.paths.keychain,
      startedAt: new Date().toISOString(),
      searchListBefore: undefined,
    },
  };
  let cleaned: Promise<void> | undefined;
  const cleanup = () => (cleaned ??= cleanupSigningDir(config.paths.signingDir, ctx.state, d));
  let interrupted = false;
  const stopListening = d.onSignal(() => {
    interrupted = true;
    d.stopCommands();
    void cleanup().finally(() => d.exit(130));
  });
  const steps = buildSteps(config).filter((s) => !s.optIn || config.addToSearchList);
  try {
    for (const [i, step] of steps.entries()) {
      if (interrupted) throw new Error("interrupted");
      d.log(`[${i + 1}/${steps.length}] ${step.title}`);
      if (step.kind === "internal") {
        await step.run(ctx, d);
      } else {
        const env = step.env?.(ctx);
        const ran = await d.run(
          step.argv(ctx).map(reveal),
          env === undefined
            ? undefined
            : Object.fromEntries(Object.entries(env).map(([k, v]) => [k, reveal(v)])),
        );
        await step.after?.(ctx, ran, d);
      }
    }
  } finally {
    stopListening();
    await cleanup();
  }
  const p = config.paths;
  d.log(
    [
      "done. Nothing here was installed or published.",
      `  DMG:       ${join(p.artifacts, p.dmg.slice(p.bundleDir.length + 1))}`,
      `  update zip: ${join(p.artifacts, p.zip.slice(p.bundleDir.length + 1))}`,
      `  metadata:  ${join(p.artifacts, p.metadata.slice(p.bundleDir.length + 1))}`,
      `  checksums: ${join(p.artifacts, "SHA256SUMS")}`,
      `  notarization: ${p.notarization}`,
      ...ctx.submissions.map(
        (s) => `    ${s.kind} ${s.file}: submission ${s.id ?? "(unreadable)"}, ${s.status}`,
      ),
      `  app:       ${p.app}`,
      `  signed host: ${p.stagedHost}`,
    ].join("\n"),
  );
}

/** Text the plan prints about the settings the route touches; docs/release/local-signing.md says the same. */
const GLOBAL_SETTINGS = [
  "Done or named on purpose: a temporary keychain file inside --out (created, unlocked, imported into, deleted); its key's ACL and partition list; a read-only snapshot of the user search list; everything the run writes under --out; dist/host (build:host empties and refills it); electron-builder's download caches under ~/Library/Caches/electron-builder; the notary uploads below.",
  "Only with --add-to-search-list: the user search list is rewritten (the temporary keychain is put first; at the end only that entry is removed, anyone else's change to the list is kept).",
  "OS side effects nobody has observed (UNVERIFIED): `security create-keychain` may list the new keychain in the user search list (`delete-keychain` removes it again); securityd and the keychain frameworks may write keychain metadata, lock or journal files and caches; spctl, stapler and codesign may update Gatekeeper, notarization or trust caches.",
  "The route never names or writes the login keychain, the default keychain, the System keychain, trust settings, login items, startup settings or anything under ~/Library/Keychains; OS-side effects there are unobserved, not ruled out.",
  "Key access: -T /usr/bin/codesign adds codesign to the key's ACL and the partition list apple-tool:,apple:,codesign: lets Apple-signed tools and apps (and codesign) use the key without a prompt while the keychain is unlocked (30 minutes idle or until sleep); this is NOT codesign-only (the partition IDs other than apple: are UNVERIFIED; the man page requires apple: for codesign).",
];

const IDENTITY_RULE =
  "Exactly one valid 'Developer ID Application' identity must be in the temporary keychain (security find-identity -v -p codesigning <keychain>); it is then named to codesign and electron-builder by its SHA-1, never by name, and always with --keychain <temporary keychain>.";

/** What goes to Apple, per backend. */
function notaryUploads(config: LocalConfig): string[] {
  const tail = [
    "the signed DMG Claudebot-<version>-arm64.dmg (the stapled app and the Applications link)",
    "The update zip is not uploaded: it is made afterwards from the app whose ticket is already stapled.",
  ];
  return config.notary.kind === "asc"
    ? [
        "Claudebot.zip: `ditto` of the signed Claudebot.app (Electron frameworks and helpers, app.asar, the signed host, resources), made by this route's afterSign hook in a temporary folder before electron-builder builds the DMG and the zip",
        ...tail,
      ]
    : [
        "Claudebot.zip: `ditto` of the signed Claudebot.app (Electron frameworks and helpers, app.asar, the signed host, resources), made by @electron/notarize in a temporary folder",
        ...tail,
      ];
}

/** The one paragraph about what the notary backend puts on a command line. */
function notarySecrets(config: LocalConfig): string {
  return config.notary.kind === "asc"
    ? "the saved asc profile's API key is never exported: no key id, issuer or key material is on any command line, in the environment or in a file of this route; only the profile's name (not a secret) is an argument of asc"
    : "the API key id and issuer (notarytool --key-id --issuer; for the length of a notarization). The .p8 contents are never on a command line";
}

/** The plan `sign-local.ts plan` prints: every operation in order with its arguments (secrets as `<labels>`), the paths, the identity rule and the global settings. It runs nothing and reads nothing. */
export function renderPlan(config: LocalConfig): string {
  const p = config.paths;
  const ctx: Ctx = {
    config,
    identity: IDENTITY_PLACEHOLDER,
    teamId: "",
    submissions: [],
    state: {
      runId: config.runId,
      pid: 0,
      keychain: p.keychain,
      startedAt: "",
      searchListBefore: undefined,
    },
  };
  const steps = buildSteps(config);
  const notaryLines =
    config.notary.kind === "asc"
      ? [
          `Notary backend: asc, saved profile ${JSON.stringify(config.notary.profile)}, binary ${config.notary.bin}`,
          `  asc is only looked up on PATH when ${LOCAL_ENV.ascBin} is not set; \`asc notarization submit --file <zip|dmg> --wait --output json\` uploads, \`asc notarization log --id <id>\` runs on a failure, \`xcrun stapler\` staples and validates`,
          "  asc reads the profile's API key itself, from wherever it stores it (UNVERIFIED: this route names no key location, exports no key and passes none on; the first use may ask you to allow access)",
        ]
      : ["Notary backend: xcrun notarytool with the API key inputs (key file, key id, issuer)"];
  const out: string[] = [
    "sign-local plan (this lists operations; nothing was run, no file was read)",
    `version ${config.version}, arch arm64, out ${p.out}`,
    "",
    "Inputs (names and paths; values never printed):",
    `  ${LOCAL_ENV.p12File} = ${config.inputs.p12File ?? "(not set)"}`,
    `  ${config.inputs.p12PasswordFile === undefined ? LOCAL_ENV.p12Password : LOCAL_ENV.p12PasswordFile} = ${config.inputs.p12PasswordFile ?? (config.inputs.p12Password === undefined ? "(not set)" : "<set, not shown>")}`,
    `  ${LOCAL_ENV.ascProfile} = ${config.inputs.ascProfile === undefined ? "(not set)" : JSON.stringify(config.inputs.ascProfile)}`,
    `  ${LOCAL_ENV.ascBin} = ${config.inputs.ascBin ?? "(not set)"}`,
    `  ${LOCAL_ENV.apiKeyFile} = ${config.inputs.apiKeyFile ?? "(not set)"}`,
    `  ${LOCAL_ENV.apiKeyId} = ${config.inputs.apiKeyId === undefined ? "(not set)" : "<set, not shown>"}`,
    `  ${LOCAL_ENV.apiIssuer} = ${config.inputs.apiIssuer === undefined ? "(not set)" : "<set, not shown>"}`,
    "",
    ...notaryLines,
    "",
    `Run refuses now because: ${config.problems.length === 0 ? "(nothing known; it also refuses a non-empty --out, a running process under --out and unreadable input files)" : ""}`,
    ...config.problems.map((m) => `  - ${m}`),
    "",
    `Identity: ${IDENTITY_RULE}`,
    "",
    "Global settings:",
    ...GLOBAL_SETTINGS.map((m) => `  ${m}`),
    `  Search list opt-in (--add-to-search-list): ${config.addToSearchList ? "ON" : "off"}`,
    "",
    "Operations, in order (a failure or a signal stops here and runs the cleanup below):",
  ];
  let n = 0;
  for (const step of steps) {
    if (step.optIn && !config.addToSearchList) continue;
    out.push(`${++n}. ${step.title}`, `   touches: ${step.touches}`);
    const commands = step.kind === "command" ? [step.argv(ctx)] : step.commands(ctx);
    for (const argv of commands) out.push(`   $ ${line(argv)}`);
    if (step.kind === "command") {
      for (const [k, v] of Object.entries(step.env?.(ctx) ?? {}))
        out.push(`   env ${k}=${show(v)}`);
    }
    for (const nested of step.nested ?? []) out.push(`     inside: ${nested}`);
  }
  out.push(
    `${++n}. Always, last: clean up`,
    "   touches: the temporary keychain, the signing folder",
    `   $ security delete-keychain ${p.keychain}`,
    "   $ security list-keychains -d user            (read only; if our entry is still listed: list-keychains -d user -s <the list without it>)",
    `   rm -r ${p.signingDir}`,
    "",
    "Uploaded to Apple:",
    ...notaryUploads(config).map((m) => `  - ${m}`),
    "",
    "Artifacts:",
    `  ${p.artifacts}/ (DMG, update zip, the zip's blockmap, latest-mac.yml, SHA256SUMS, NOTARIZATION.json with every submission id and status; no DMG blockmap)`,
    `  ${p.bundleDir}/ (electron-builder's output, including the unpacked app)`,
    `  ${p.stagedHost} (the signed host)`,
    "",
    `Secrets that unavoidably appear on a command line (visible to the same user's \`ps\` while the command runs): the .p12 password (security import -P, about a second), the keychain's random password (create-keychain -p, unlock-keychain -p, set-key-partition-list -k; each under a second; the keychain is deleted at the end), and for the notary: ${notarySecrets(config)}. The .p12 contents are never on a command line.`,
  );
  return `${out.join("\n")}\n`;
}
