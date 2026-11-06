import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorOf, post } from "./api.ts";

export function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const submit = async () => {
    setBusy(true);
    const r = await post("/api/bots/new", { name, purpose });
    setBusy(false);
    if (!r.ok) return setError(await errorOf(r));
    setName("");
    setPurpose("");
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
            <Field>
              <FieldLabel htmlFor="bot-name">Name</FieldLabel>
              <Input id="bot-name" autoFocus placeholder="e.g. PR reviewer" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bot-purpose">Purpose</FieldLabel>
              <Textarea id="bot-purpose" placeholder="What is this bot for?" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              <FieldDescription>Optional. Other bots see it when they pick who to hand work to.</FieldDescription>
            </Field>
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
