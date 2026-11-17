import { TrashIcon } from "@phosphor-icons/react";
import type { BotSummary } from "@tomte/contract/events";
import { useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deleteBot } from "@/host/api.ts";

import { ProfileForm } from "./profile-form.tsx";

/** The Profile section: who the bot is, and at the bottom the one way to remove it. */
export function ProfileSection({ bot }: { bot: BotSummary }) {
  const [removing, startRemoving] = useTransition();
  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${bot.name}?`,
      description:
        "Its routines are removed, its browser logins are signed out and its open handoffs fail. Memory and files are moved to the trash folder in the data root (bots/.trash).",
      action: "Delete",
      destructive: true,
    });
    if (ok)
      startRemoving(async () => {
        await deleteBot(bot.id);
      });
  };
  return (
    <div className="grid gap-8">
      <ProfileForm bot={bot} />
      <section className="grid gap-2 border-t pt-4" aria-labelledby="bot-danger-zone">
        <h3 id="bot-danger-zone" className="text-destructive text-sm font-medium">
          Danger zone
        </h3>
        <div className="border-destructive/30 flex items-center gap-3 rounded-lg border p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Delete bot</p>
            <p className="text-muted-foreground text-xs">
              {bot.status === "working"
                ? "Available once the bot finishes its turn."
                : "Removes the bot and its routines."}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={bot.status === "working" || removing}
            onClick={() => void remove()}
          >
            {removing ? <Spinner /> : <TrashIcon />} Delete bot
          </Button>
        </div>
      </section>
    </div>
  );
}
