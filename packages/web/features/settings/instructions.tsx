import { MAX_TEXT_DOCUMENT } from "@tomte/contract/api";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import { loadInstructions, saveInstructions } from "./api.ts";

/**
 * Instructions: what the user tells every bot, then `aboutYou` (the shared user memory, from the memory feature). Saved
 * instructions reach each bot from its next session.
 */
export function Instructions({ aboutYou }: { aboutYou: ReactNode }) {
  const [saved, setSaved] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    let live = true;
    loadInstructions().then(
      (text) => live && setSaved(text),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const value = draft ?? saved ?? "";
  const dirty = draft !== undefined && draft !== saved;
  const save = () => {
    if (draft === undefined || draft === saved) return;
    startSaving(async () => {
      if (!(await saveInstructions(draft))) return;
      setSaved(draft);
      setDraft(undefined);
      toast.success("Instructions saved");
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <Field>
        <FieldLabel htmlFor="instructions">Instructions for every bot</FieldLabel>
        <Textarea
          id="instructions"
          value={value}
          rows={10}
          maxLength={MAX_TEXT_DOCUMENT}
          disabled={saved === undefined}
          readOnly={saving}
          className="max-h-[60vh] font-mono text-xs leading-relaxed md:text-xs"
          placeholder={
            saved === undefined && !error
              ? "Loading…"
              : "Always answer in British English. Ask before spending money."
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        <FieldDescription>
          Added to every bot's system prompt, after its own identity. A change reaches each bot from
          its next session; chats that are open restart when they are idle.
        </FieldDescription>
        {error && <p className="text-destructive text-sm break-words">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(undefined)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </div>
      </Field>
      {aboutYou}
    </div>
  );
}
