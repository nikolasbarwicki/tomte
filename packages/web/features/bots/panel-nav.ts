/** The bot panel's tabs, in the order they show; `tasks` only for a double-loop bot. */
export const PANEL_TABS = ["work", "tasks", "files", "browser", "settings"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** The pages under the panel's Settings tab; without one the tab shows its overview. */
export const BOT_SECTIONS = ["profile", "chat", "memory", "routines", "permissions"] as const;
export type BotSection = (typeof BOT_SECTIONS)[number];
