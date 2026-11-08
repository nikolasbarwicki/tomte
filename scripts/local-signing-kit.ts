// The parts of the local macOS signing route that need no keychain: what it is given and from where, which paths it
// uses, what makes it refuse, how it keeps a secret out of everything it prints, the state file that lets `cleanup`
// finish after a crash, the keychain search list arithmetic and the rewrite of `latest-mac.yml` after the DMG is stapled.
// `local-signing.ts` runs the steps, `sign-local.ts` is the command line, docs/release/local-signing.md is the guide.
import { dirname, isAbsolute, join, resolve } from "node:path";

import { bundleDirName, bundledAppPath, desktopAssets, hostBinaryName } from "./desktop-kit.ts";
import { parseTag } from "./release-kit.ts";
import { MAC_ENTITLEMENTS } from "./signing-kit.ts";

/** Environment variable names the route reads. Values are read once and removed from the environment children inherit. */
export const LOCAL_ENV = {
  p12File: "CLAUDEBOT_LOCAL_P12_FILE",
  p12PasswordFile: "CLAUDEBOT_LOCAL_P12_PASSWORD_FILE",
  p12Password: "CLAUDEBOT_LOCAL_P12_PASSWORD",
  apiKeyFile: "CLAUDEBOT_LOCAL_API_KEY_FILE",
  apiKeyId: "CLAUDEBOT_LOCAL_API_KEY_ID",
  apiIssuer: "CLAUDEBOT_LOCAL_API_ISSUER",
} as const;

/** A value that must never reach a log, a printed command line or a file: it prints as `<label>`, also through JSON and template strings. */
export class Secret {
  constructor(
    readonly label: string,
    readonly value: string,
  ) {}
  toString(): string {
    return `<${this.label}>`;
  }
  toJSON(): string {
    return this.toString();
  }
}

/** One command-line argument: plain text, or a {@link Secret} that the plan shows as its label and a run passes as its value. */
export type Arg = string | Secret;

export const reveal = (arg: Arg): string => (typeof arg === "string" ? arg : arg.value);
export const show = (arg: Arg): string => (typeof arg === "string" ? arg : arg.toString());

export interface LocalInputs {
  p12File: string | undefined;
  p12PasswordFile: string | undefined;
  p12Password: string | undefined;
  apiKeyFile: string | undefined;
  apiKeyId: string | undefined;
  apiIssuer: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The inputs named in `env`; an empty value counts as unset. */
export function readLocalInputs(env: Env): LocalInputs {
  const get = (name: string) => (env[name] ?? "").trim() || undefined;
  return {
    p12File: get(LOCAL_ENV.p12File),
    p12PasswordFile: get(LOCAL_ENV.p12PasswordFile),
    p12Password: get(LOCAL_ENV.p12Password),
    apiKeyFile: get(LOCAL_ENV.apiKeyFile),
    apiKeyId: get(LOCAL_ENV.apiKeyId),
    apiIssuer: get(LOCAL_ENV.apiIssuer),
  };
}

/** What stops a run on the inputs alone: names, not values. The password comes from exactly one of its two variables. */
export function inputProblems(inputs: LocalInputs): string[] {
  const problems = [
    [LOCAL_ENV.p12File, inputs.p12File],
    [LOCAL_ENV.apiKeyFile, inputs.apiKeyFile],
    [LOCAL_ENV.apiKeyId, inputs.apiKeyId],
    [LOCAL_ENV.apiIssuer, inputs.apiIssuer],
  ].flatMap(([name, value]) => (value === undefined ? [`${name} is not set`] : []));
  const passwords = [inputs.p12PasswordFile, inputs.p12Password].filter((v) => v !== undefined);
  if (passwords.length !== 1) {
    problems.push(
      `exactly one of ${LOCAL_ENV.p12PasswordFile} and ${LOCAL_ENV.p12Password} must be set`,
    );
  }
  for (const [name, value] of [
    [LOCAL_ENV.p12File, inputs.p12File],
    [LOCAL_ENV.p12PasswordFile, inputs.p12PasswordFile],
    [LOCAL_ENV.apiKeyFile, inputs.apiKeyFile],
  ] as const) {
    if (value !== undefined && !isAbsolute(value))
      problems.push(`${name} must be an absolute path`);
  }
  return problems;
}

export interface LocalSecrets {
  keychainPassword: Secret;
  p12Password: Secret;
  apiKeyId: Secret;
  apiIssuer: Secret;
}

/** Secrets for a plan: labels only, nothing read. */
export function placeholderSecrets(): LocalSecrets {
  return {
    keychainPassword: new Secret("keychain-password", ""),
    p12Password: new Secret("p12-password", ""),
    apiKeyId: new Secret("api-key-id", ""),
    apiIssuer: new Secret("api-issuer", ""),
  };
}

interface LocalPaths {
  /** The staging folder: nothing of this route lives outside it except `dist/host` (what `build:host` always writes). */
  out: string;
  /** Holds the temporary keychain and the state file; removed when the run ends, kept only by a hard kill. */
  signingDir: string;
  keychain: string;
  state: string;
  /** The signed host, the `--host-dir` of the packaging run. */
  hostDir: string;
  stagedHost: string;
  /** `package:desktop`'s output folder. */
  bundleDir: string;
  app: string;
  dmg: string;
  zip: string;
  metadata: string;
  /** The finished installers, metadata and `SHA256SUMS`. */
  artifacts: string;
  entitlements: string;
}

function localPaths(out: string, runId: string, version: string): LocalPaths {
  const [dmg, zip] = desktopAssets("darwin", ["arm64"], version).installers as [string, string];
  const bundleDir = join(out, bundleDirName("darwin", ["arm64"]));
  const signingDir = join(out, ".signing");
  const hostDir = join(out, "host");
  return {
    out,
    signingDir,
    keychain: join(signingDir, `${runId}.keychain-db`),
    state: join(signingDir, "state.json"),
    hostDir,
    stagedHost: join(hostDir, hostBinaryName("darwin", "arm64")),
    bundleDir,
    app: join(bundleDir, bundledAppPath("darwin", "arm64")),
    dmg: join(bundleDir, dmg),
    zip: join(bundleDir, zip),
    metadata: join(bundleDir, desktopAssets("darwin", ["arm64"], version).metadata),
    artifacts: join(out, "artifacts"),
    entitlements: MAC_ENTITLEMENTS,
  };
}

export interface LocalFlags {
  out: string | undefined;
  version: string | undefined;
  arch: readonly string[];
  confirm: boolean;
  addToSearchList: boolean;
}

export interface LocalConfig {
  repoRoot: string;
  version: string;
  runId: string;
  addToSearchList: boolean;
  inputs: LocalInputs;
  secrets: LocalSecrets;
  paths: LocalPaths;
  /** What makes `run` refuse on what is known without touching the disk; `plan` prints them and still plans. */
  problems: string[];
}

/** A usage error: the command line itself is wrong, so there is nothing to plan. */
export class UsageError extends Error {}

/**
 * The configuration of one invocation. Throws {@link UsageError} when `--out`, `--version` or `--arch` are wrong; the
 * rest that stops a real run (CI, no confirmation flag, not macOS, missing inputs) is listed in `problems`.
 */
export function resolveLocalConfig(r: {
  flags: LocalFlags;
  inputs: LocalInputs;
  platform: string;
  ci: boolean;
  repoRoot: string;
  hostVersion: string;
  runId: string;
  secrets: LocalSecrets;
}): LocalConfig {
  const { flags } = r;
  if (flags.out === undefined) throw new UsageError("--out <staging folder> is required");
  if (flags.arch.some((a) => a !== "arm64")) {
    throw new UsageError(`--arch ${flags.arch.join(", ")}: only arm64 is supported`);
  }
  const version = flags.version ?? r.hostVersion;
  try {
    parseTag(`v${version}`);
  } catch {
    throw new UsageError(`--version ${version}: expected MAJOR.MINOR.PATCH[-prerelease]`);
  }
  const out = resolve(flags.out);
  if (out.split("/").includes("Keychains")) {
    throw new UsageError(
      `--out ${out} lies in a Keychains folder; the temporary keychain is never created there`,
    );
  }
  const problems: string[] = [];
  if (r.ci) problems.push("this is a CI environment (CI is set); the local route never runs in CI");
  if (r.platform !== "darwin") problems.push(`this is ${r.platform}; the local route needs macOS`);
  if (!flags.confirm) {
    problems.push("--confirm-keychain-and-notary-upload was not given");
  }
  problems.push(...inputProblems(r.inputs));
  return {
    repoRoot: r.repoRoot,
    version,
    runId: r.runId,
    addToSearchList: flags.addToSearchList,
    inputs: r.inputs,
    secrets: r.secrets,
    paths: localPaths(out, r.runId, version),
    problems,
  };
}

/** The shape `notarytool submit --output-format json` prints. */
export function parseNotarySubmission(stdout: string): {
  id: string | undefined;
  status: string | undefined;
} {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const field = (name: string) =>
      typeof parsed === "object" && parsed !== null && name in parsed
        ? String((parsed as Record<string, unknown>)[name])
        : undefined;
    return { id: field("id"), status: field("status") };
  } catch {
    return { id: undefined, status: undefined };
  }
}

/** The keychains `security list-keychains -d user` prints, one quoted path per line. */
export function parseKeychainList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((line) => line !== "");
}

/** What `cleanup` needs after a crash, written before the first keychain command. */
export interface LocalState {
  runId: string;
  pid: number;
  keychain: string;
  startedAt: string;
  /** The user search list before the run (read-only snapshot); `undefined` until it was taken. */
  searchListBefore: string[] | undefined;
}

export function serializeState(state: LocalState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Reads a state file. The keychain it names must lie inside `signingDir`: a damaged or planted file can never make
 * `cleanup` delete a keychain anywhere else.
 */
export function parseState(text: string, signingDir: string): LocalState {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("the state file is not an object");
  const o = raw as Record<string, unknown>;
  const list = o.searchListBefore;
  if (
    typeof o.runId !== "string" ||
    typeof o.pid !== "number" ||
    typeof o.keychain !== "string" ||
    typeof o.startedAt !== "string" ||
    !(list === undefined || (Array.isArray(list) && list.every((k) => typeof k === "string")))
  ) {
    throw new Error("the state file is not in the expected shape");
  }
  if (!isAbsolute(o.keychain) || dirname(o.keychain) !== resolve(signingDir)) {
    throw new Error(
      `the state file names ${o.keychain}, which is not directly inside ${signingDir}`,
    );
  }
  return {
    runId: o.runId,
    pid: o.pid,
    keychain: o.keychain,
    startedAt: o.startedAt,
    searchListBefore: list as string[] | undefined,
  };
}

/**
 * The list to set so that only `temp` leaves `current`, or `undefined` when `temp` is not in it. `changed` is true when
 * what remains differs from `before`, i.e. someone else changed the list meanwhile; their changes are kept, never undone.
 */
export function withoutKeychain(
  current: readonly string[],
  temp: string,
  before: readonly string[],
): { list: string[]; changed: boolean } | undefined {
  if (!current.includes(temp)) return undefined;
  const list = current.filter((k) => k !== temp);
  return { list, changed: list.length !== before.length || list.some((k, i) => k !== before[i]) };
}

const UPDATE_FILE_KEYS = ["sha512", "size"] as const;

/**
 * `latest-mac.yml` with the `sha512` and `size` of the file `url` replaced. electron-builder wrote them for the DMG as it
 * was before signing and stapling; both change the bytes. Only that entry changes; throws when it is not listed.
 */
export function replaceUpdateFile(
  text: string,
  url: string,
  replacement: { sha512: string; size: number },
): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) =>
      /^\s*-?\s*url:\s*/.test(l) &&
      l
        .replace(/^\s*-?\s*url:\s*/, "")
        .replace(/^['"]|['"]$/g, "")
        .trim() === url,
  );
  if (start < 0) throw new Error(`the update metadata does not list ${url}`);
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*-\s/.test(line) || /^\S/.test(line)) break;
    for (const key of UPDATE_FILE_KEYS) {
      const m = new RegExp(`^(\\s*${key}:\\s*)`).exec(line);
      if (m) {
        lines[i] = `${m[1]}${replacement[key]}`;
        seen.add(key);
      }
    }
  }
  if (seen.size !== UPDATE_FILE_KEYS.length) {
    throw new Error(`the update metadata's entry for ${url} lacks sha512 or size`);
  }
  return lines.join("\n");
}
