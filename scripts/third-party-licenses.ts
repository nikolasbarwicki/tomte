// Writes the license folder every distribution ships (ADR-0013): Tomte's LICENSE and NOTICE, and
// THIRD-PARTY-LICENSES.txt with the license text of every npm package the shipped workspaces depend on at runtime
// (host and web, which the host binary embeds, and the desktop main process), plus the vendored texts in licenses/
// for what is not an npm package (the agent-browser engine). The dependency walk follows `dependencies`,
// `optionalDependencies` and installed `peerDependencies` from those workspaces' package.json files through
// node_modules, so it lists a superset of what the bundlers keep; a superset is the safe side for a notice.
//
// Usage: bun scripts/third-party-licenses.ts <outDir>
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SHIPPED = ["packages/host", "packages/web", "packages/desktop", "packages/contract"];
const VENDORED = join(ROOT, "licenses");
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

interface Manifest {
  name: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Package {
  name: string;
  version: string;
  license: string;
  texts: { file: string; text: string }[];
}

/** Node's lookup: `<dir>/node_modules/<name>` from `dir` up to the root, realpath'd (Bun's store uses symlinks). */
function locate(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dirname(dir) === dir) return undefined;
  }
}

/** Every non-workspace package reachable from the shipped workspaces, sorted by name and version. */
async function collectPackages(): Promise<Package[]> {
  const seen = new Map<string, Package>();
  const visited = new Set<string>();
  const queue = SHIPPED.map((p) => join(ROOT, p));
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visited.has(dir)) continue;
    visited.add(dir);
    const m = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Manifest;
    const deps = [
      ...Object.keys(m.dependencies ?? {}),
      ...Object.keys(m.optionalDependencies ?? {}),
      ...Object.keys(m.peerDependencies ?? {}),
    ];
    for (const name of deps) {
      const found = locate(name, dir);
      if (found === undefined) {
        if (m.dependencies?.[name] !== undefined)
          throw new Error(`${m.name}: dependency ${name} is not installed`);
        continue;
      }
      queue.push(found);
    }
    if (dir.includes("node_modules")) {
      const key = `${m.name}@${m.version ?? "?"}`;
      if (seen.has(key)) continue;
      const files = (await readdir(dir)).filter((f) => LICENSE_FILE.test(f)).sort();
      const texts = await Promise.all(
        files.map(async (file) => ({
          file,
          text: (await readFile(join(dir, file), "utf8")).trim(),
        })),
      );
      const license = typeof m.license === "string" ? m.license : (m.license?.type ?? "UNKNOWN");
      seen.set(key, { name: m.name, version: m.version ?? "?", license, texts });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

const RULE = "=".repeat(80);

/** The text of THIRD-PARTY-LICENSES.txt: an index, then each package's license, then the vendored texts. */
function formatLicenses(packages: Package[], vendored: { file: string; text: string }[]): string {
  const index = packages.map((p) => `- ${p.name}@${p.version}: ${p.license}`);
  const sections = packages.map((p) =>
    [
      RULE,
      `${p.name}@${p.version}`,
      `License: ${p.license}`,
      RULE,
      "",
      p.texts.length === 0
        ? "(The package ships no license file; its package.json declares the license above.)"
        : p.texts.map((t) => `--- ${t.file} ---\n\n${t.text}`).join("\n\n"),
    ].join("\n"),
  );
  const extra = vendored.map((v) =>
    [RULE, v.file.replace(/\.txt$/, ""), RULE, "", v.text.trim()].join("\n"),
  );
  return [
    "Third-party software in Tomte",
    "",
    "Tomte's own license is in LICENSE and NOTICE. The components below keep their own licenses.",
    "",
    ...index,
    "",
    ...sections,
    ...extra,
    "",
  ].join("\n\n");
}

/** Writes LICENSE, NOTICE and THIRD-PARTY-LICENSES.txt into `outDir`. */
export async function writeLicenses(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const vendored = await Promise.all(
    (await readdir(VENDORED))
      .filter((f) => f.endsWith(".txt"))
      .sort()
      .map(async (file) => ({ file, text: await readFile(join(VENDORED, file), "utf8") })),
  );
  await writeFile(
    join(outDir, "THIRD-PARTY-LICENSES.txt"),
    formatLicenses(await collectPackages(), vendored),
  );
  await copyFile(join(ROOT, "LICENSE"), join(outDir, "LICENSE"));
  await copyFile(join(ROOT, "NOTICE"), join(outDir, "NOTICE"));
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error("usage: bun scripts/third-party-licenses.ts <outDir>");
    process.exit(2);
  }
  await writeLicenses(out);
  console.log(`wrote LICENSE, NOTICE and THIRD-PARTY-LICENSES.txt to ${out}`);
}
