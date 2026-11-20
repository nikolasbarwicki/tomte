// What a person checks first on a published Release (ticket 07, box 1): download every asset into a folder and run
// `bun scripts/release.ts verify-release <folder> <version>`. Everything here is offline and read-only: the folder holds
// exactly the files the release workflow publishes, `SHA256SUMS` lists exactly those and every hash matches, its
// Ed25519 signature `SHA256SUMS.sig` verifies against the public key pinned in this checkout's `deploy/install.sh`,
// `release.json` is a manifest of this version, the installer's `DEFAULT_REPO` was filled in and pins that same key,
// and every `latest*.yml` names the version and the real sha512 and size of the files it points at (what
// electron-updater verifies before it installs).
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ReleaseManifest } from "../packages/contract/src/api.ts";
import {
  type DesktopScope,
  desktopAssets,
  releaseAssets,
  scopedPlatforms,
  SUPPORTED_DESKTOP,
} from "./desktop-kit.ts";
import {
  CHECKSUM_FILE,
  checkSignature,
  INSTALLER_FILE,
  LICENSE_FILES,
  MANIFEST_FILE,
  SIGNATURE_FILE,
  sha256,
} from "./release-kit.ts";

/** The unit that ships beside the installer (`release.yml`, `publish`). */
const SERVICE_UNIT = "tomte.service";

interface UpdateFile {
  url: string;
  sha512: string;
  size: number;
}

export interface UpdateMetadata {
  version: string | undefined;
  /** The top-level `path`/`sha512` electron-builder writes for older updaters: the first file. */
  path: string | undefined;
  sha512: string | undefined;
  files: UpdateFile[];
}

const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/, "$2");

/**
 * Reads the keys electron-updater uses from electron-builder's `latest*.yml`: top-level `version`, `path`, `sha512`
 * and the `files:` list of `url`/`sha512`/`size`. electron-builder writes plain block YAML, so this is a line reader,
 * not a YAML parser; anything it cannot read is left out and surfaces as a failed check.
 */
export function parseUpdateMetadata(text: string): UpdateMetadata {
  const meta: UpdateMetadata = {
    version: undefined,
    path: undefined,
    sha512: undefined,
    files: [],
  };
  let current: Partial<UpdateFile> | undefined;
  let inFiles = false;
  const finish = () => {
    if (current?.url !== undefined && current.sha512 !== undefined && current.size !== undefined) {
      meta.files.push({ url: current.url, sha512: current.sha512, size: current.size });
    }
    current = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9]+):\s*(.*?)\s*$/.exec(line);
    if (top?.[1] !== undefined) {
      finish();
      inFiles = top[1] === "files";
      const value = unquote(top[2] ?? "");
      if (top[1] === "version") meta.version = value;
      if (top[1] === "path") meta.path = value;
      if (top[1] === "sha512") meta.sha512 = value;
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*(-\s+)?(url|sha512|size):\s*(.*?)\s*$/.exec(line);
    if (item?.[2] === undefined) continue;
    if (item[1] !== undefined) finish();
    current ??= {};
    const value = unquote(item[3] ?? "");
    if (item[2] === "url") current.url = value;
    if (item[2] === "sha512") current.sha512 = value;
    if (item[2] === "size" && /^\d+$/.test(value)) current.size = Number(value);
  }
  finish();
  return meta;
}

export function sha512Base64(path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("sha512");
  const stream = Bun.file(path).stream();
  void (async () => {
    for await (const chunk of stream) hash.update(chunk);
    resolve(hash.digest("base64"));
  })().catch(reject);
  return promise;
}

/** `sha256sum` lines (`<64 hex>  <name>`); malformed and duplicate lines are reported, not skipped. */
export function parseChecksums(text: string): {
  entries: Map<string, string>;
  problems: string[];
} {
  const entries = new Map<string, string>();
  const problems: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}([^/\s][^/]*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      problems.push(`${CHECKSUM_FILE} line ${i + 1} is not "<sha256>  <file>": ${line}`);
    } else if (entries.has(match[2])) {
      problems.push(`${CHECKSUM_FILE} lists ${match[2]} more than once`);
    } else {
      entries.set(match[2], match[1]);
    }
  }
  return { entries, problems };
}

/** The files `release.ts checksums` requires before it writes `SHA256SUMS`: the host binaries, the scope's installers
 * and metadata, the license files and `release.json`, so a release missing one fails before it is signed. */
export function checksumRequirements(
  version: string,
  scope: DesktopScope = SUPPORTED_DESKTOP,
): string[] {
  return [...releaseAssets(version, scope), ...LICENSE_FILES, MANIFEST_FILE];
}

/** What electron-updater applies per OS; the dmg and the deb are for people, not for the updater. */
const updatable = (name: string): boolean =>
  name.endsWith("-mac.zip") || name.endsWith(".exe") || name.endsWith(".AppImage");

/**
 * Blockmaps a release must carry: the updater's differential download reads the zip's, the exe's and the AppImage's.
 * The `.deb` (fpm) has none, and the DMG's is optional: CI ships the one electron-builder writes, while a stapled DMG
 * (the local signing route, `scripts/local-signing.ts`) has none, since stapling changes the bytes it was built from.
 */
const blockmapRequired = (installer: string): boolean =>
  !installer.endsWith(".deb") && !installer.endsWith(".dmg");

/** Every file name a release folder holds for `version` and the scope's installers (all of them when published). */
export function expectedFiles(
  version: string,
  scope: DesktopScope = SUPPORTED_DESKTOP,
): { required: string[]; optional: string[] } {
  const installers = scopedPlatforms(scope).flatMap(
    (p) => desktopAssets(p, scope[p], version).installers,
  );
  return {
    required: [
      ...releaseAssets(version, scope),
      ...installers.filter(blockmapRequired).map((n) => `${n}.blockmap`),
      INSTALLER_FILE,
      SERVICE_UNIT,
      ...LICENSE_FILES,
      CHECKSUM_FILE,
      SIGNATURE_FILE,
      MANIFEST_FILE,
    ],
    optional: installers.filter((n) => !blockmapRequired(n)).map((n) => `${n}.blockmap`),
  };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function checkMetadata(
  dir: string,
  name: string,
  version: string,
  scope: DesktopScope,
): Promise<string[]> {
  const problems: string[] = [];
  const meta = parseUpdateMetadata(await readFile(join(dir, name), "utf8"));
  if (meta.version !== version) {
    problems.push(`${name} names version ${meta.version ?? "(none)"}, the release is ${version}`);
  }
  if (meta.files.length === 0) problems.push(`${name} lists no files`);
  const platform = scopedPlatforms(scope).find(
    (p) => desktopAssets(p, scope[p], version).metadata === name,
  );
  const installers = platform ? desktopAssets(platform, scope[platform], version).installers : [];
  for (const wanted of installers.filter(updatable)) {
    if (!meta.files.some((f) => f.url === wanted)) problems.push(`${name} does not list ${wanted}`);
  }
  const listed = [
    ...meta.files,
    ...(meta.path ? [{ url: meta.path, sha512: meta.sha512, size: undefined }] : []),
  ];
  for (const file of listed) {
    const path = join(dir, file.url);
    if (!(await isFile(path))) {
      problems.push(`${name} lists ${file.url}, which is not in the folder`);
      continue;
    }
    if (file.size !== undefined && (await stat(path)).size !== file.size) {
      problems.push(
        `${name}: ${file.url} is ${(await stat(path)).size} bytes, the metadata says ${file.size}`,
      );
    }
    if (file.sha512 !== undefined && (await sha512Base64(path)) !== file.sha512) {
      problems.push(`${name}: sha512 of ${file.url} does not match the file`);
    }
  }
  return problems;
}

async function checkManifest(dir: string, version: string): Promise<string[]> {
  let parsed: ReleaseManifest;
  try {
    parsed = ReleaseManifest.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")));
  } catch (e) {
    return [`${MANIFEST_FILE} is not a release manifest: ${(e as Error).message}`];
  }
  const problems: string[] = [];
  if (parsed.version !== version) {
    problems.push(`${MANIFEST_FILE} names version ${parsed.version}, the release is ${version}`);
  }
  if (parsed.shellApi.min > parsed.shellApi.max) {
    problems.push(`${MANIFEST_FILE} has an empty shellApi range`);
  }
  return problems;
}

/**
 * Checks a downloaded Release folder against `version` and returns every problem found (empty: the folder is a
 * complete, consistent release). `scope` narrows the installers required, for a local dry run (`--only`); a published
 * release is always checked against every supported installer. Never writes; a folder that cannot be read throws.
 */
export async function verifyRelease(
  dir: string,
  version: string,
  publicKey: string,
  scope: DesktopScope = SUPPORTED_DESKTOP,
): Promise<string[]> {
  const problems: string[] = [];
  const names = await readdir(dir);
  const files: string[] = [];
  for (const name of names) {
    if (await isFile(join(dir, name))) files.push(name);
    else problems.push(`${name} is not a file`);
  }

  const { required, optional } = expectedFiles(version, scope);
  for (const name of required) {
    if (!files.includes(name)) problems.push(`missing: ${name}`);
  }
  for (const name of files) {
    if (!required.includes(name) && !optional.includes(name)) problems.push(`unexpected: ${name}`);
  }

  if (files.includes(CHECKSUM_FILE)) {
    const { entries, problems: bad } = parseChecksums(
      await readFile(join(dir, CHECKSUM_FILE), "utf8"),
    );
    problems.push(...bad);
    const covered = files.filter((n) => n !== CHECKSUM_FILE && n !== SIGNATURE_FILE);
    for (const name of covered) {
      const expected = entries.get(name);
      if (expected === undefined) problems.push(`${CHECKSUM_FILE} has no entry for ${name}`);
      else if ((await sha256(join(dir, name))) !== expected) {
        problems.push(`sha256 mismatch: ${name} does not match ${CHECKSUM_FILE}`);
      }
    }
    for (const name of entries.keys()) {
      if (!covered.includes(name))
        problems.push(`${CHECKSUM_FILE} lists ${name}, which is not in the folder`);
    }
  }

  if (files.includes(CHECKSUM_FILE) && files.includes(SIGNATURE_FILE)) {
    const sums = await readFile(join(dir, CHECKSUM_FILE));
    const signature = await readFile(join(dir, SIGNATURE_FILE));
    if (!checkSignature(sums, signature, publicKey)) {
      problems.push(
        `${SIGNATURE_FILE} is not a valid signature of ${CHECKSUM_FILE} by the pinned release key`,
      );
    }
  }

  if (files.includes(MANIFEST_FILE)) problems.push(...(await checkManifest(dir, version)));

  if (files.includes(INSTALLER_FILE)) {
    const text = await readFile(join(dir, INSTALLER_FILE), "utf8");
    const repo = /^DEFAULT_REPO="([^"]*)"$/m.exec(text)?.[1];
    if (repo === undefined) problems.push(`${INSTALLER_FILE} has no DEFAULT_REPO line`);
    else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      problems.push(`${INSTALLER_FILE} has DEFAULT_REPO="${repo}", expected OWNER/REPO`);
    }
    const pinned = /^RELEASE_PUBLIC_KEY="([^"]*)"$/m.exec(text)?.[1];
    if (pinned !== publicKey) {
      problems.push(`${INSTALLER_FILE} does not pin the release public key of this checkout`);
    }
  }

  for (const platform of scopedPlatforms(scope)) {
    const { metadata } = desktopAssets(platform, scope[platform], version);
    if (files.includes(metadata))
      problems.push(...(await checkMetadata(dir, metadata, version, scope)));
  }
  return problems;
}
