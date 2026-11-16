import { createLazyRoute, Navigate, useParams } from "@tanstack/react-router";

import { Channels } from "@/features/channels/index.ts";
import { Credentials } from "@/features/credentials/index.ts";
import { Devices } from "@/features/devices/index.ts";
import { MemoryEditor } from "@/features/memory/index.ts";
import { SETTINGS_SECTIONS, SettingsScreen } from "@/features/settings/index.ts";
import { useBots, useCredentials } from "@/host/hooks.ts";

function CredentialsSection() {
  const credentials = useCredentials();
  const bots = useBots();
  return <Credentials credentials={credentials} bots={bots ?? []} />;
}

const slots = {
  aboutYou: (
    <MemoryEditor
      scope="user"
      title="About you"
      description="What every bot knows about you. Bots add to it as they learn; you can edit it here."
      empty="Nothing yet. Bots save what they learn about you here, or write it yourself."
    />
  ),
  devices: <Devices />,
  channels: <Channels />,
  credentials: <CredentialsSection />,
};

export const Route = createLazyRoute("/settings/$section")({
  component: function SettingsRoute() {
    const { section } = useParams({ from: "/settings/$section" });
    const known = SETTINGS_SECTIONS.find((s) => s === section);
    if (!known) return <Navigate to="/settings/$section" params={{ section: "general" }} replace />;
    return <SettingsScreen section={known} slots={slots} />;
  },
});
