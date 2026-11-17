import { Link } from "@tanstack/react-router";
import {
  CpuIcon,
  InfoIcon,
  MessageSquareTextIcon,
  MonitorSmartphoneIcon,
  SendIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { AppBar } from "@/components/page.tsx";
import { cn } from "@/lib/utils";

import { About } from "./about.tsx";
import { Connections } from "./connections.tsx";
import { General } from "./general.tsx";
import { Instructions } from "./instructions.tsx";
import { Models } from "./models.tsx";
import type { SettingsSection } from "./sections.ts";

const SECTIONS: Record<
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
    icon: MessageSquareTextIcon,
  },
  models: {
    label: "Models",
    description: "The providers your bots run on, and whether this host is signed in to them.",
    icon: CpuIcon,
  },
  connections: {
    label: "Connections",
    description: "The host this app talks to, and the devices paired with it.",
    icon: MonitorSmartphoneIcon,
  },
  channels: {
    label: "Channels",
    description:
      "Where the host reaches you outside this app. Link your account with a one-time code; messages from any other account are ignored.",
    icon: SendIcon,
  },
  about: {
    label: "About",
    description: "Versions, and what this host runs bots with.",
    icon: InfoIcon,
  },
};

/** What other features contribute to the screen; the route fills these in, so this feature imports none of them. */
type SettingsSlots = {
  /** The shared user memory, shown under Instructions. */
  aboutYou: ReactNode;
  /** The paired devices, shown under Connections. */
  devices: ReactNode;
  /** The Channels section's content. */
  channels: ReactNode;
};

/** The Settings screen: a title bar, the section list (a side column, or a scrolling row on narrow windows) and the open section. */
export function SettingsScreen({
  section,
  slots,
}: {
  section: SettingsSection;
  slots: SettingsSlots;
}) {
  const meta = SECTIONS[section];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppBar>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Settings</h1>
      </AppBar>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Settings sections"
          className="shrink-0 border-b md:w-52 md:overflow-y-auto md:border-r md:border-b-0"
        >
          <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3">
            {(Object.keys(SECTIONS) as SettingsSection[]).map((s) => {
              const { label, icon: Icon } = SECTIONS[s];
              return (
                <li key={s} className="shrink-0">
                  <Link
                    to="/settings/$section"
                    params={{ section: s }}
                    aria-current={s === section ? "page" : undefined}
                    className={cn(
                      "text-muted-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground md:whitespace-normal",
                      s === section &&
                        "bg-accent text-accent-foreground font-medium hover:bg-accent",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6">
            <header>
              <h2 className="text-lg font-semibold">{meta.label}</h2>
              <p className="text-muted-foreground text-sm">{meta.description}</p>
            </header>
            <Content section={section} slots={slots} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Content({ section, slots }: { section: SettingsSection; slots: SettingsSlots }) {
  switch (section) {
    case "general":
      return <General />;
    case "instructions":
      return <Instructions aboutYou={slots.aboutYou} />;
    case "models":
      return <Models />;
    case "connections":
      return <Connections devices={slots.devices} />;
    case "channels":
      return slots.channels;
    case "about":
      return <About />;
  }
}
