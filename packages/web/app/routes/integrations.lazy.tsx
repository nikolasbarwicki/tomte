import { createLazyRoute } from "@tanstack/react-router";

import { IntegrationsScreen } from "./integrations-screen.tsx";

export const Route = createLazyRoute("/integrations")({
  component: () => <IntegrationsScreen selectedId={undefined} />,
});
