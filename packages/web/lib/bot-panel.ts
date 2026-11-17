/** Every section the bot panel can show; the `panel` search param of a bot's page holds one. `profile` is opened from the chat's top bar and has no rail icon. */
export const PANEL_SECTIONS = [
  "work",
  "tasks",
  "browser",
  "files",
  "memory",
  "routines",
  "permissions",
  "events",
  "profile",
] as const;
export type PanelSection = (typeof PANEL_SECTIONS)[number];

export type RailSection = Exclude<PanelSection, "profile">;

/** The sections with a rail icon, in the order the rail (and the narrow window's switcher) shows them; it never changes. The last group sits at the bottom of the rail. */
export const RAIL_GROUPS: readonly (readonly RailSection[])[] = [
  ["work", "tasks", "browser"],
  ["files", "memory", "routines"],
  ["permissions", "events"],
];

export const PANEL_TITLES: Record<PanelSection, string> = {
  work: "Work",
  tasks: "Tasks",
  browser: "Browser",
  files: "Files",
  memory: "Memory",
  routines: "Routines",
  permissions: "Permissions",
  events: "Events endpoint",
  profile: "Profile",
};

/** The section a panel opens on when the link names none. */
export const DEFAULT_PANEL_SECTION: PanelSection = "work";

/** What a link's `panel` may name: a section, or `settings`, the tab the sections of a Settings page lived under before the panel had a rail. */
export const LINKED_PANELS = [...PANEL_SECTIONS, "settings"] as const;

/**
 * The section a link opens. A link made when the panel had tabs, `panel=settings&section=routines`, named a page under the
 * Settings tab; that page is now a section of its own. The Chat & model page became the model chip in the message box, so
 * a link to it (or to the bare tab) opens Profile.
 */
export const upgradePanel = (
  panel: (typeof LINKED_PANELS)[number] | undefined,
  section: PanelSection | undefined,
): PanelSection | undefined => (panel === "settings" ? (section ?? "profile") : panel);
