import { useState } from "react";
import { Plus } from "lucide-react";
import type { Integration } from "../../src/contract/events.ts";
import { Page } from "../page.tsx";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CustomForm } from "./custom-form.tsx";
import { IntegrationDetail } from "./detail.tsx";
import { IntegrationsList } from "./list.tsx";

/** The global Integrations screen: the list, or one integration's detail page when `selectedId` names one that exists. */
export function Integrations({
  integrations,
  selectedId,
  onSelect,
  onTry,
}: {
  integrations: Integration[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Opens a chat with `prompt` filled in; undefined while there is no bot to open. */
  onTry: ((prompt: string) => void) | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const selected = integrations.find((i) => i.id === selectedId);
  if (selected)
    return (
      <Page key={selected.id} title="Integrations">
        <IntegrationDetail integration={selected} onBack={() => onSelect(undefined)} onTry={onTry} />
      </Page>
    );
  return (
    <Page
      title="Integrations"
      description="MCP servers and skills shared by every bot. Changes apply on each bot's next turn."
      actions={
        <Dialog open={adding} onOpenChange={setAdding}>
          <DialogTrigger render={<Button size="sm" variant="outline" />}>
            <Plus data-icon="inline-start" />
            Add custom
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add custom MCP server</DialogTitle>
              <DialogDescription>Connect a remote server by URL, or run one locally as a command.</DialogDescription>
            </DialogHeader>
            {adding && (
              <CustomForm
                onDone={(id) => {
                  setAdding(false);
                  onSelect(id);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      }
    >
      <IntegrationsList integrations={integrations} onOpen={onSelect} />
    </Page>
  );
}
