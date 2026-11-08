import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The app's own log, `logs/desktop.log` in the user-data folder (the host's stays in `host.log`): each line goes to stderr and, timestamped, to the file. A file that cannot be written never stops the app. */
export function createDesktopLog(
  file: string,
  now: () => Date = () => new Date(),
): (message: string) => void {
  return (message) => {
    console.error(`[desktop] ${message}`);
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${now().toISOString()} [desktop] ${message}\n`);
    } catch {
      // The log is a convenience; the app does not depend on it.
    }
  };
}
