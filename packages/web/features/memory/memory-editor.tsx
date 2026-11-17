import { PencilSimpleIcon } from "@phosphor-icons/react";
import { MAX_TEXT_DOCUMENT } from "@tomte/contract/api";
import { useState, useTransition } from "react";
import { Streamdown } from "streamdown";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useMemory } from "@/host/hooks.ts";

import { saveMemory } from "./api.ts";

type Scope = { scope: "user" } | { scope: "bot"; botId: string };

/**
 * One memory file, read as Markdown and editable in place. `user` is what every bot knows about the user; `bot` is the open
 * bot's own directions (the host streams only the open bot's). Saving replaces the whole file; the bot reads it the next
 * time its session opens.
 */
export function MemoryEditor({
  title,
  description,
  empty,
  ...target
}: Scope & { title: string; description: string; empty: string }) {
  const text = useMemory(target.scope);
  const [draft, setDraft] = useState<{ text: string; base: string }>();
  const [saving, startSaving] = useTransition();
  const id = `memory-${target.scope}`;
  const save = () =>
    startSaving(async () => {
      if (!draft) return;
      const update =
        target.scope === "user"
          ? { scope: "user" as const, text: draft.text }
          : { scope: "bot" as const, botId: target.botId, text: draft.text };
      if (await saveMemory(update)) setDraft(undefined);
    });
  return (
    <section className="grid gap-2" aria-labelledby={`${id}-title`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-title`} className="text-sm font-medium">
            {title}
          </h3>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        {!draft && (
          <Button
            variant="outline"
            size="xs"
            aria-label={`Edit ${title}`}
            onClick={() => setDraft({ text, base: text })}
          >
            <PencilSimpleIcon /> Edit
          </Button>
        )}
      </div>
      {draft ? (
        <div className="grid gap-2">
          <Textarea
            id={id}
            aria-label={title}
            autoFocus
            value={draft.text}
            maxLength={MAX_TEXT_DOCUMENT}
            rows={8}
            className="max-h-[60vh] font-mono text-xs leading-relaxed md:text-xs"
            placeholder="One line per fact or direction, in Markdown."
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              if (e.key === "Escape") setDraft(undefined);
            }}
          />
          {text !== draft.base && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              The bot saved something new while you were editing; saving replaces it with your text.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || draft.text === text} onClick={save}>
              {saving && <Spinner />} Save
            </Button>
          </div>
        </div>
      ) : text.trim() ? (
        <div className="bg-muted/50 rounded-lg p-3 text-sm break-words">
          <Streamdown linkSafety={{ enabled: false }}>{text}</Streamdown>
        </div>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">{empty}</p>
      )}
    </section>
  );
}
