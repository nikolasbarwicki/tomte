import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

const Settings = z.object({
  startAtLogin: z.boolean(),
  /** What this computer's host does while a server is shown: `always` keeps running, `while-shown` runs only while This computer is shown. Absent until the user is asked (once, the first time a server is shown); absent runs it, as before the question existed. */
  localHost: z.enum(["always", "while-shown"]).optional(),
});

/** The desktop app's own settings, `settings.json` in its user-data folder; the host keeps its settings in the data root. */
export type DesktopSettings = z.infer<typeof Settings>;

export type LocalHostSetting = NonNullable<DesktopSettings["localHost"]>;

export interface SettingsStore {
  get(): DesktopSettings;
  /** Writes the file with `patch` applied, then changes what `get` returns; a failed write throws and changes nothing. */
  update(patch: Partial<DesktopSettings>): void;
}

const FIRST_LAUNCH: DesktopSettings = { startAtLogin: true };

function save(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** A missing file is a first launch: the defaults, written to `file`. A file that cannot be read or parsed is left as it is, so a user's choice is never overwritten by a guess, and the safe values apply: nothing registers itself at login. */
function load(file: string, log: (message: string) => void): DesktopSettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`could not read ${file}: ${String(error)}`);
      return { startAtLogin: false };
    }
    save(file, FIRST_LAUNCH);
    return FIRST_LAUNCH;
  }
  try {
    return Settings.parse(JSON.parse(text));
  } catch (error) {
    log(`${file} is not valid settings (${String(error)}); using the safe defaults`);
    return { startAtLogin: false };
  }
}

/** The one reader and writer of `file`: every setting changes through `update`, so a change to one never drops another. */
export function openSettings(file: string, log: (message: string) => void): SettingsStore {
  let current = load(file, log);
  return {
    get: () => current,
    update(patch) {
      const next = { ...current, ...patch };
      save(file, next);
      current = next;
    },
  };
}
