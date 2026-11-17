import {
  ChatTeardropTextIcon,
  CpuIcon,
  DevicesIcon,
  InfoIcon,
  PaperPlaneRightIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";

/** The Settings sections as the navigation groups them, in its order; each is `/settings/<section>`. */
export const SETTINGS_GROUPS = [
  { title: "Workspace", sections: ["general", "instructions", "models"] },
  { title: "Host", sections: ["connections", "channels", "about"] },
] as const;

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]["sections"][number];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (g) => g.sections,
);

export const SECTIONS: Record<
  SettingsSection,
  { label: string; description: string; icon: ComponentType<{ className?: string }> }
> = {
  general: {
    label: "General",
    description: "Theme and the folder your bots work in.",
    icon: SlidersHorizontalIcon,
  },
  instructions: {
    label: "Instructions",
    description: "What every bot is told, and what they all know about you.",
    icon: ChatTeardropTextIcon,
  },
  models: {
    label: "Models",
    description: "The providers your bots run on, and whether this host is signed in to them.",
    icon: CpuIcon,
  },
  connections: {
    label: "Connections",
    description: "The host this app talks to, and the devices paired with it.",
    icon: DevicesIcon,
  },
  channels: {
    label: "Channels",
    description:
      "Where the host reaches you outside this app. Link your account with a one-time code; messages from any other account are ignored.",
    icon: PaperPlaneRightIcon,
  },
  about: {
    label: "About",
    description: "Versions, and what this host runs bots with.",
    icon: InfoIcon,
  },
};
