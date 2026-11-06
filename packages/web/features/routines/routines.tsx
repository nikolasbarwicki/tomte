import type { Routine } from "@claudebot/contract/events";
import { AlarmClockIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useRoutines } from "@/host/hooks.ts";

import { RoutineForm } from "./routine-form.tsx";
import { RoutineItem } from "./routine-item.tsx";

export function Routines({ botId }: { botId: string }) {
  const routines = useRoutines()?.routines ?? [];
  const [editing, setEditing] = useState<Routine>();
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const edit = (r?: Routine) => {
    setEditing(r);
    setFormKey((k) => k + 1);
    setOpen(true);
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">Instructions this bot runs on a schedule.</p>
        <Button variant="outline" size="sm" onClick={() => edit()}>
          <PlusIcon /> New routine
        </Button>
      </div>
      {routines.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlarmClockIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No routines yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Have the bot do something every morning, every hour or once at a set time. You can
              also ask it in chat to set one up.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => edit()}>
              <PlusIcon /> New routine
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="grid gap-2">
          {routines.map((r) => (
            <RoutineItem key={r.id} r={r} onEdit={() => edit(r)} />
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <RoutineForm
            key={formKey}
            botId={botId}
            routine={editing}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
