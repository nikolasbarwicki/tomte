// Bundles the desktop app's main process into packages/desktop/dist/main.cjs (gitignored):
//   bun run build:desktop
// Electron itself is not bundled, and neither is any host code: the main process only spawns the host binary.
import { cp, rm } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/desktop/src/main.ts");
const ASSETS = join(ROOT, "packages/desktop/assets");
/** The tray icons, next to the bundle where the main process looks for them. */
export const ASSETS_OUT = join(ROOT, "packages/desktop/dist/assets");
export const MAIN_OUT = join(ROOT, "packages/desktop/dist/main.cjs");

/** CommonJS because Electron loads the main file by its package.json `main`, and the staged app package has no `"type": "module"`. */
export async function buildMain(): Promise<void> {
  await rm(join(ROOT, "packages/desktop/dist"), { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "node",
    format: "cjs",
    external: ["electron"],
    outdir: join(ROOT, "packages/desktop/dist"),
    naming: "main.cjs",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(`${log.name}: ${log.message}`);
    throw new Error("bundling the desktop main process failed");
  }
  await cp(ASSETS, ASSETS_OUT, { recursive: true });
  console.log(`built ${relative(ROOT, MAIN_OUT)}`);
}

if (import.meta.main) await buildMain();
