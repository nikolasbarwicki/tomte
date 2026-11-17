import { join } from "node:path";

/** The host binary the app runs: the one packaging copied into the app's resources, or, when run from source, this machine's `bun run build:host` output. */
export function hostBinaryPath(packaged: boolean, resourcesPath: string, repoRoot: string): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  if (packaged) return join(resourcesPath, `tomte-host${exe}`);
  const os = process.platform === "win32" ? "windows" : process.platform;
  return join(repoRoot, "dist/host", `tomte-host-${os}-${process.arch}${exe}`);
}
