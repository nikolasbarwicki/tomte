/** The Settings screen's sections, in the order its navigation lists them; each is `/settings/<section>`. */
export const SETTINGS_SECTIONS = [
  "general",
  "instructions",
  "models",
  "connections",
  "channels",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
