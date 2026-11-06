import { createLazyRoute } from "@tanstack/react-router";
import { IntegrationsScreen } from "./integrations-screen.tsx";

export const Route = createLazyRoute("/integrations/$integrationId")({
  component: function Integration() {
    return <IntegrationsScreen selectedId={Route.useParams().integrationId} />;
  },
});
