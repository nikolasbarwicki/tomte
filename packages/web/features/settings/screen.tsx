import type { ReactNode } from "react";

import { AppBar } from "@/components/page.tsx";

import { About } from "./about.tsx";
import { Connections } from "./connections.tsx";
import { General } from "./general.tsx";
import { Instructions } from "./instructions.tsx";
import { Models } from "./models.tsx";
import { SECTIONS, type SettingsSection } from "./sections.ts";

/** What other features contribute to the screen; the route fills these in, so this feature imports none of them. */
type SettingsSlots = {
  /** The shared user memory, shown under Instructions. */
  aboutYou: ReactNode;
  /** The paired devices, shown under Connections. */
  devices: ReactNode;
  /** The Channels section's content. */
  channels: ReactNode;
};

/** The Settings screen: the open section in one centred column. Its section list is in the sidebar (`SettingsNav`). */
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
      <AppBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 pt-6 pb-10 md:px-8">
          <header className="grid gap-1">
            <h2 className="text-xl font-semibold tracking-tight">{meta.label}</h2>
            <p className="text-muted-foreground text-[13px]">{meta.description}</p>
          </header>
          <Content section={section} slots={slots} />
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
