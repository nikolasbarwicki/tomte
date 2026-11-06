import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FACE_NAMES, STROKE_NAMES, STROKES } from "@claudebot/contract/avatars";
import { randomAvatar } from "./avatars.ts";
import { BotAvatar } from "./bot-avatar.tsx";
import { errorOf, post } from "./api.ts";

const choice = "relative grid cursor-pointer place-items-center rounded-lg ring-1 ring-transparent transition-colors hover:bg-muted has-checked:bg-muted has-checked:ring-foreground/40 has-focus-visible:ring-2 has-focus-visible:ring-ring";

export function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [avatar, setAvatar] = useState(randomAvatar);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const submit = async () => {
    setBusy(true);
    const r = await post("/api/bots/new", { name, purpose, ...avatar });
    setBusy(false);
    if (!r.ok) return setError(await errorOf(r));
    setName("");
    setPurpose("");
    setAvatar(randomAvatar());
    setError("");
    onOpenChange(false);
    const { id } = z.object({ id: z.string() }).parse(await r.json());
    void navigate({ to: "/bots/$botId", params: { botId: id } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
            <DialogDescription>A bot is one long-running conversation dedicated to one job, with its own memory, files and routines.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="flex items-end gap-3">
              <BotAvatar avatar={avatar} className="size-14 rounded-xl bg-muted p-1" />
              <Field className="flex-1">
                <FieldLabel htmlFor="bot-name">Name</FieldLabel>
                <Input id="bot-name" autoFocus placeholder="e.g. PR reviewer" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="bot-purpose">Purpose</FieldLabel>
              <Textarea id="bot-purpose" placeholder="What is this bot for?" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              <FieldDescription>Optional. Other bots see it when they pick who to hand work to.</FieldDescription>
            </Field>
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Avatar</FieldLegend>
              <div className="grid grid-cols-5 gap-1">
                {FACE_NAMES.map((face) => (
                  <label key={face} className={cn(choice, "h-12")} title={face}>
                    <input type="radio" name="bot-face" value={face} checked={avatar.face === face} onChange={() => setAvatar({ ...avatar, face })} className="sr-only" />
                    <BotAvatar avatar={{ face, stroke: avatar.stroke }} className="size-10" />
                    <span className="sr-only">{face}</span>
                  </label>
                ))}
              </div>
            </FieldSet>
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Stroke color</FieldLegend>
              <div className="flex flex-wrap gap-1">
                {STROKE_NAMES.map((stroke) => (
                  <label key={stroke} className={cn(choice, "size-8 rounded-full")} title={stroke}>
                    <input type="radio" name="bot-stroke" value={stroke} checked={avatar.stroke === stroke} onChange={() => setAvatar({ ...avatar, stroke })} className="sr-only" />
                    <span className="size-5 rounded-full" style={{ background: STROKES[stroke] }} />
                    <span className="sr-only">{stroke}</span>
                  </label>
                ))}
              </div>
            </FieldSet>
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
