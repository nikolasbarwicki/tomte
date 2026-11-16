import { Bot } from "@claudebot/contract/events";
import { useNavigate } from "@tanstack/react-router";
import { useActionState, useState } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorOf, readJson } from "@/host/api.ts";
import { randomAvatar } from "@/lib/avatars.ts";

import { createBot } from "./api.ts";
import { AvatarPicker } from "./avatar-picker.tsx";

export function NewBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [avatar, setAvatar] = useState(randomAvatar);
  const navigate = useNavigate();
  const [error, submit, busy] = useActionState(async () => {
    const r = await createBot({ name, purpose, ...avatar });
    if (!r.ok) return errorOf(r);
    setName("");
    setPurpose("");
    setAvatar(randomAvatar());
    onOpenChange(false);
    const { id } = await readJson(r, Bot);
    void navigate({ to: "/bots/$botId", params: { botId: id } });
    return "";
  }, "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form action={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
            <DialogDescription>
              A bot is one long-running conversation dedicated to one job, with its own memory,
              files and routines.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="flex items-end gap-3">
              <BotAvatar avatar={avatar} className="bg-muted size-14 rounded-xl p-1" />
              <Field className="flex-1">
                <FieldLabel htmlFor="bot-name">Name</FieldLabel>
                <Input
                  id="bot-name"
                  autoFocus
                  placeholder="e.g. PR reviewer"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="bot-purpose">Purpose</FieldLabel>
              <Textarea
                id="bot-purpose"
                placeholder="What is this bot for?"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
              <FieldDescription>
                Optional. Other bots see it when they pick who to hand work to.
              </FieldDescription>
            </Field>
            <AvatarPicker avatar={avatar} onChange={setAvatar} />
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Spinner />} Create bot
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
