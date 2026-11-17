// Notarization through a saved profile of the Rork `asc` CLI, the second backend of the local signing route
// (docs/release/local-signing.md). The profile's API key stays in the keychain `asc` keeps it in: this route passes no key
// material, only the profile's name. `package-desktop.ts` runs {@link notarizeSignedApp} as electron-builder's `afterSign`
// hook, `local-signing.ts` calls {@link notarizeWithAsc} for the DMG. Every command goes through the injected Runner.
//
// The JSON `asc notarization submit --output json` prints and its exit code on a rejection are not known (the help text
// does not say), so the output is read defensively and anything but an explicit "Accepted" is a failure.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { CommandError, type Runner } from "./command-runner.ts";
import { sha256 } from "./release-kit.ts";

/** What was uploaded to Apple's notary service and what came back; holds no secret. */
export interface NotarySubmission {
  kind: "app" | "dmg";
  /** The uploaded file's name (`Tomte.zip` for the app). */
  file: string;
  sha256: string;
  /** `undefined` only when asc reported Accepted without a readable id. */
  id: string | undefined;
  status: string;
}

export interface AscNotary {
  /** The `asc` executable. */
  bin: string;
  /** The saved profile's name (not a secret). */
  profile: string;
}

/** `asc --profile <name> notarization submit …`; `--read-only` would refuse the submission, so it is not passed. */
export function ascSubmitArgv(asc: AscNotary, file: string): string[] {
  return [
    asc.bin,
    "--profile",
    asc.profile,
    "notarization",
    "submit",
    "--file",
    file,
    "--wait",
    "--output",
    "json",
  ];
}

export function ascLogArgv(asc: AscNotary, id: string): string[] {
  return [asc.bin, "--profile", asc.profile, "notarization", "log", "--id", id];
}

/** `ditto`'s archive of a signed app, the file the app's submission uploads. */
export function appZipArgv(app: string, zip: string): string[] {
  return ["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zip];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The first parsable JSON document in `stdout`: all of it, else the last line that parses (progress lines may come first). */
function parseJson(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let from = 0; from < lines.length; from++) {
    try {
      return JSON.parse(lines.slice(from).join("\n"));
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The submission id and final status from what `asc notarization submit` printed. Looks in the document, its `data`
 * (an object or the first element of an array), its `submission` and each one's `attributes`; the first string `id` and
 * the first string `status` win. Both are `undefined` when nothing readable is there.
 */
export function parseAscSubmission(stdout: string): {
  id: string | undefined;
  status: string | undefined;
} {
  const root = parseJson(stdout);
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const top = asRecord(first(root));
  const containers = [top, asRecord(first(top?.data)), asRecord(first(top?.submission))].flatMap(
    (c) => (c === undefined ? [] : [c, asRecord(c.attributes)]),
  );
  const find = (key: "id" | "status") => {
    for (const c of containers) {
      const value = c?.[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  };
  return { id: find("id"), status: find("status") };
}

/** Apple's developer log URL for a submission, or why it could not be fetched; never throws. */
async function fetchLog(run: Runner, asc: AscNotary, id: string | undefined): Promise<string> {
  if (id === undefined) return "";
  try {
    return `\nlog: ${(await run(ascLogArgv(asc, id))).stdout.trim()}`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `\n(the log of submission ${id} could not be fetched: ${why})`;
  }
}

const excerpt = (text: string) => {
  const t = text.trim();
  return t === "" ? "(empty)" : t.length > 400 ? `${t.slice(0, 400)}…` : t;
};

/**
 * Uploads `file` (a zip or dmg) and waits for Apple's verdict. Resolves only on an explicit Accepted; otherwise throws
 * with the status, the submission id and, when there is an id, the output of `asc notarization log --id` (a URL).
 */
export async function notarizeWithAsc(r: {
  run: Runner;
  asc: AscNotary;
  file: string;
  kind: NotarySubmission["kind"];
  log: (line: string) => void;
}): Promise<NotarySubmission> {
  const name = basename(r.file);
  const digest = await sha256(r.file);
  let stdout: string;
  let failure: CommandError | undefined;
  try {
    stdout = (await r.run(ascSubmitArgv(r.asc, r.file))).stdout;
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    failure = error;
    stdout = error.stdout;
  }
  const { id, status } = parseAscSubmission(stdout);
  if (failure !== undefined || status === undefined || status.trim().toLowerCase() !== "accepted") {
    const why = failure === undefined ? "" : `${failure.message}; `;
    const seen =
      id === undefined && status === undefined ? `; asc printed: ${excerpt(stdout)}` : "";
    throw new Error(
      `notarizing ${name} with asc failed: ${why}status ${status ?? "(unreadable)"}, submission ${id ?? "(none)"}, sha256 ${digest}${seen}${await fetchLog(r.run, r.asc, id)}`,
    );
  }
  if (id === undefined)
    r.log(`warning: asc accepted ${name} but printed no readable submission id`);
  r.log(`notarized ${name} with asc (submission ${id ?? "(unreadable)"}, sha256 ${digest})`);
  return { kind: r.kind, file: name, sha256: digest, id, status };
}

/**
 * electron-builder's `afterSign` step for the asc backend: zip the signed app, notarize the zip, staple and validate the
 * app. electron-builder runs it after signing and before it builds the dmg and zip targets, so both hold the stapled
 * app. The submission goes to `recordFile` as JSON for the caller (`sign-local.ts`) to report.
 */
export async function notarizeSignedApp(r: {
  run: Runner;
  asc: AscNotary;
  app: string;
  recordFile: string;
  log: (line: string) => void;
}): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "tomte-asc-notary-"));
  try {
    const zip = join(work, `${basename(r.app, ".app")}.zip`);
    await r.run(appZipArgv(r.app, zip));
    const submission = await notarizeWithAsc({ ...r, file: zip, kind: "app" });
    await writeFile(r.recordFile, `${JSON.stringify(submission, null, 2)}\n`);
    await r.run(["xcrun", "stapler", "staple", r.app]);
    await r.run(["xcrun", "stapler", "validate", r.app]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Reads the file {@link notarizeSignedApp} wrote; throws when it is not a submission. */
export async function readSubmissionRecord(file: string): Promise<NotarySubmission> {
  const raw = asRecord(JSON.parse(await readFile(file, "utf8")));
  const { kind, id } = raw ?? {};
  if (
    raw === undefined ||
    (kind !== "app" && kind !== "dmg") ||
    typeof raw.file !== "string" ||
    typeof raw.sha256 !== "string" ||
    typeof raw.status !== "string" ||
    !(id === undefined || id === null || typeof id === "string")
  ) {
    throw new Error(`${file} is not a notarization record`);
  }
  return { kind, file: raw.file, sha256: raw.sha256, id: id ?? undefined, status: raw.status };
}
