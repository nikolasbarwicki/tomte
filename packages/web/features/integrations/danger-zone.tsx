import type { Integration } from "@claudebot/contract/events";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { disconnect, removeIntegration } from "./api.ts";
import { Section, useIntegrationAction, type IntegrationAction } from "./parts.tsx";

export function DangerZone({ integration: i }: { integration: Integration }) {
  const disconnecting = useIntegrationAction(i.id);
  const removing = useIntegrationAction(i.id);
  const busy = disconnecting.busy || removing.busy;
  const custom = i.catalogId === null;
  const connected = i.state !== "disconnected";
  if (!custom && !connected) return null;
  const confirmed = async (
    action: IntegrationAction,
    command: (id: string) => Promise<boolean>,
    title: string,
    description: string,
    confirm: string,
  ) => {
    if (await confirmAction({ title, description, action: confirm, destructive: true }))
      action.run(command);
  };
  return (
    <Section title="Danger zone" className="border-destructive/30 divide-y">
      {connected && (
        <DangerRow
          title={`Disconnect ${i.label}`}
          description="Deletes its secret from the keychain. Tool settings are kept, so reconnecting restores them."
          action="Disconnect"
          disabled={busy}
          pending={disconnecting.busy}
          onClick={() =>
            void confirmed(
              disconnecting,
              disconnect,
              `Disconnect ${i.label}?`,
              "Its stored secret is deleted; tool settings are kept.",
              "Disconnect",
            )
          }
        />
      )}
      {custom && (
        <DangerRow
          title={`Remove ${i.label}`}
          description="Deletes the server, its tool settings and its secrets. Adding it again starts from scratch."
          action="Remove"
          disabled={busy}
          pending={removing.busy}
          onClick={() =>
            void confirmed(
              removing,
              removeIntegration,
              `Remove ${i.label}?`,
              "The server and its tool settings are deleted.",
              "Remove",
            )
          }
        />
      )}
    </Section>
  );
}

function DangerRow({
  title,
  description,
  action,
  disabled,
  pending,
  onClick,
}: {
  title: string;
  description: string;
  action: string;
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Button variant="destructive" size="sm" disabled={disabled} onClick={onClick}>
        {pending && <Spinner data-icon="inline-start" />}
        {action}
      </Button>
    </div>
  );
}
