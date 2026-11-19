import type { LoginItem } from "./login-item.ts";
import type { SettingsStore } from "./settings.ts";

export interface StartAtLogin {
  enabled(): boolean;
  /** Records the choice in the settings file and registers or removes the login item. */
  set(enabled: boolean): void;
}

/** Applies the stored setting to the OS login item, as on every launch. */
export function createStartAtLogin(settings: SettingsStore, item: LoginItem): StartAtLogin {
  item.set(settings.get().startAtLogin);
  return {
    enabled: () => settings.get().startAtLogin,
    set(next) {
      settings.update({ startAtLogin: next });
      item.set(next);
    },
  };
}
