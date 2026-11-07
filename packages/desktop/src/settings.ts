import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

const Settings = z.object({ startAtLogin: z.boolean() });

/** The desktop app's own settings, `settings.json` in its user-data folder; the host keeps its settings in the data root. */
export type DesktopSettings = z.infer<typeof Settings>;

const FIRST_LAUNCH: DesktopSettings = { startAtLogin: true };

export function saveSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** A missing file is a first launch: the defaults, written to `file`. A file that cannot be read or parsed is left as it is, so a user's choice is never overwritten by a guess, and the safe values apply: nothing registers itself at login. */
export function loadSettings(file: string, log: (message: string) => void): DesktopSettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`could not read ${file}: ${String(error)}`);
      return { startAtLogin: false };
    }
    saveSettings(file, FIRST_LAUNCH);
    return FIRST_LAUNCH;
  }
  try {
    return Settings.parse(JSON.parse(text));
  } catch (error) {
    log(`${file} is not valid settings (${String(error)}); using the safe defaults`);
    return { startAtLogin: false };
  }
}
