// Builds the web UI, then compiles the host with that UI embedded into one standalone binary per target:
//   bun run build:host                      all five targets
//   bun run build:host darwin-arm64 …       only these targets, for local work
// Binaries land in dist/host/ (gitignored) as claudebot-host-<os>-<arch>[.exe].
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { EMBEDDED_UI_DIR } from "../packages/host/src/ui/index.ts";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/host/src/main.ts");
const WEB_BUILD = join(ROOT, "packages/web/dist");
const OUT = join(ROOT, "dist/host");
const STAGE = join(OUT, ".stage");

/**
 * The compile targets. Every x64 target is the baseline build (no AVX2): the modern build dies with an illegal
 * instruction on x64 VPS and VM CPU models that hide AVX2 and under Rosetta, and the host is I/O-bound, so the
 * SIMD speedup buys nothing. Linux is glibc; there is no musl target.
 */
const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64-baseline",
} as const satisfies Record<string, Bun.Build.CompileTarget>;
type Target = keyof typeof TARGETS;

const isTarget = (name: string): name is Target => name in TARGETS;

const outfile = (target: Target) =>
  join(OUT, `claudebot-host-${target}${target.startsWith("windows") ? ".exe" : ""}`);

async function buildWeb(): Promise<void> {
  const web = Bun.spawn(["bun", "run", "build:web"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await web.exited) !== 0) throw new Error("the web build failed");
}

async function compile(target: Target): Promise<void> {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    // Minified: the bundle is mostly dependencies nobody reads (about 1 MB smaller). The sourcemap is embedded compressed (about 2 MB), so a crash report from a user's machine still names source files and lines.
    minify: true,
    sourcemap: "linked",
    // Vite only serves the dev UI (`--vite`) and needs the web package source; a binary refuses that flag at startup.
    external: ["vite"],
    compile: {
      target: TARGETS[target],
      outfile: outfile(target),
      assets: [join(STAGE, EMBEDDED_UI_DIR)],
      // A server binary must not pick up a `.env` or `bunfig.toml` from whatever directory it is started in.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error(`compiling ${target} failed`);
  }
  // The map is already embedded in the binary; the build also writes it beside the binary, where nothing reads it.
  await rm(outfile(target).replace(/(\.exe)?$/, ".map"), { force: true });
  const { size } = await stat(outfile(target));
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `built ${relative(ROOT, outfile(target))}  ${TARGETS[target]}  ${(size / 1e6).toFixed(1)} MB  ${seconds}s`,
  );
}

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const unknown = positionals.filter((p) => !isTarget(p));
  if (unknown.length) {
    console.error(
      `unknown target ${unknown.join(", ")}; expected ${Object.keys(TARGETS).join(", ")}`,
    );
    return 2;
  }
  const targets = positionals.length
    ? positionals.filter(isTarget)
    : (Object.keys(TARGETS) as Target[]);

  await buildWeb();
  // The binary embeds the folder as `EMBEDDED_UI_DIR`, whatever the web build calls its output folder.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await cp(WEB_BUILD, join(STAGE, EMBEDDED_UI_DIR), { recursive: true });
  try {
    for (const target of targets) await compile(target);
  } finally {
    await rm(STAGE, { recursive: true, force: true });
  }
  return 0;
}

process.exitCode = await main();
