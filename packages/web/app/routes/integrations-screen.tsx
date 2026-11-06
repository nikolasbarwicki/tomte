import { useNavigate } from "@tanstack/react-router";
import { Integrations } from "@/features/integrations/index.ts";
import { useBots, useIntegrations, useOpenBotId } from "@/host/hooks.ts";

export function IntegrationsScreen({ selectedId }: { selectedId: string | undefined }) {
  const bots = useBots();
  const openBotId = useOpenBotId();
  const integrations = useIntegrations();
  const navigate = useNavigate();
  return (
    <Integrations
      integrations={integrations}
      selectedId={selectedId}
      onSelect={(id) => void (id ? navigate({ to: "/integrations/$integrationId", params: { integrationId: id } }) : navigate({ to: "/integrations" }))}
      onTry={
        bots?.length
          ? (text) => {
              const botId = openBotId ?? bots[0].id;
              void navigate({ to: "/bots/$botId", params: { botId }, search: { draft: text } });
            }
          : undefined
      }
    />
  );
}
