import { createLazyRoute } from "@tanstack/react-router";

import { Credentials } from "@/features/credentials/index.ts";
import { useBots, useCredentials } from "@/host/hooks.ts";

export const Route = createLazyRoute("/credentials")({
  component: function CredentialsScreen() {
    const credentials = useCredentials();
    const bots = useBots();
    return <Credentials credentials={credentials} bots={bots ?? []} />;
  },
});
