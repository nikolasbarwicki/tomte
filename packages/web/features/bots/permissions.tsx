import type { ToolAllowances } from "@tomte/contract/api";
import type { BotSummary } from "@tomte/contract/events";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useChat } from "@/host/hooks.ts";

import { fetchAllowances, removeAllowance } from "./api.ts";

/** The tools the owner chose "Always allow for this bot" on, each with a way to take the rule back. */
export function Permissions({ bot }: { bot: BotSummary }) {
  const [rules, setRules] = useState<ToolAllowances["allowances"] | { error: string }>();
  const [removing, startRemoving] = useTransition();
  // A rule added on a card in this chat shows up without reopening the panel.
  const added = useChat().items.filter(
    (i) => i.kind === "approve" && i.answer === "allow_always",
  ).length;
  useEffect(() => {
    let current = true;
    void fetchAllowances(bot.id).then((r) => {
      if (current) setRules("error" in r ? r : r.allowances);
    });
    return () => {
      current = false;
    };
  }, [bot.id, added]);
  const remove = (tool: string) =>
    startRemoving(async () => {
      if (await removeAllowance(bot.id, tool))
        setRules((now) => (Array.isArray(now) ? now.filter((r) => r.tool !== tool) : now));
    });
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-xs">
        Tools {bot.name} may always use without asking, chosen on an approval card. A tool switched
        off in Integrations stays off.
      </p>
      {rules === undefined ? (
        <Spinner className="text-muted-foreground" />
      ) : !Array.isArray(rules) ? (
        <p className="text-destructive text-sm">{rules.error}</p>
      ) : rules.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
          Nothing is always allowed yet.
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="allowances">
          {rules.map((r) => (
            <li key={r.tool} className="bg-muted/50 flex items-center gap-2 rounded-lg px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-sm" title={r.tool}>
                {r.tool}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={removing}
                aria-label={`Remove ${r.tool}`}
                onClick={() => remove(r.tool)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
