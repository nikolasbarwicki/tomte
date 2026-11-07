import type { LoginItem } from "./login-item.ts";
import { loadSettings, saveSettings } from "./settings.ts";

export interface StartAtLogin {
  enabled(): boolean;
  /** Records the choice in the settings file and registers or removes the login item. */
  set(enabled: boolean): void;
}

/** Reads the settings (writing them on a first launch) and applies them to the OS login item, as on every launch. */
export function createStartAtLogin(
  settingsFile: string,
  item: LoginItem,
  log: (message: string) => void,
): StartAtLogin {
  let enabled = loadSettings(settingsFile, log).startAtLogin;
  item.set(enabled);
  return {
    enabled: () => enabled,
    set(next) {
      saveSettings(settingsFile, { startAtLogin: next });
      item.set(next);
      enabled = next;
    },
  };
}
