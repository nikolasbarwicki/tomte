import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * The directory every bot's Claude CLI runs in, inside the data root; created on first use. Claude Code keeps its session files per working directory,
 * so replaying a bot's transcript reads that directory's sessions. Resolved through symlinks because Claude Code names a session folder after the resolved path.
 */
export function ensureWorkspace(dataRoot: string): string {
  const dir = join(dataRoot, "workspace");
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}
