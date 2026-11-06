import { useState } from "react";
import { Info, Search } from "lucide-react";
import type { Integration, IntegrationTool, ToolPolicy } from "@claudebot/contract/events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { policyCounts, toolGroups } from "./model.ts";
import { Section, useIntegrationAction } from "./parts.tsx";
import { resetPolicies, setPolicy } from "./api.ts";

const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

export function Permissions({ integration: i }: { integration: Integration }) {
  const reset = useIntegrationAction(i.id);
  const policy = useIntegrationAction(i.id);
  const busy = reset.busy || policy.busy;
  const [query, setQuery] = useState("");
  const counts = policyCounts(i.tools);
  const groups = toolGroups(i.tools, query);
  return (
    <Section
      title="Permissions"
      description={`${i.tools.length} ${i.tools.length === 1 ? "tool" : "tools"} · ${counts.auto} Auto · ${counts.ask} Ask · ${counts.off} Off`}
      action={
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={busy} onClick={() => reset.run(resetPolicies)} />}>
            {reset.busy && <Spinner data-icon="inline-start" />}
            Reset to defaults
          </TooltipTrigger>
          <TooltipContent>Read-only tools Auto, the rest Ask</TooltipContent>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-3 border-b p-4">
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            Off hides a tool, Ask waits for your approval, Auto runs it. <strong className="font-medium text-foreground">Ask tools are denied in scheduled routines</strong>; set Auto on
            tools a routine needs.
            {i.state !== "connected" && " Settings are kept while disconnected and apply again on reconnect."}
          </span>
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" placeholder="Search tools…" aria-label={`Search ${i.label} tools`} className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {groups.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No tools match</p>}
      {groups.map((g) => (
        <div key={g.kind} className="border-b last:border-b-0">
          <div className="flex items-baseline gap-2 bg-muted/40 px-4 py-1.5">
            <h3 className={g.kind === "destructive" ? "text-xs font-medium text-destructive" : "text-xs font-medium"}>{g.label}</h3>
            <span className="text-xs text-muted-foreground">
              {g.hint} · {g.tools.length}
            </span>
          </div>
          <ul className="divide-y">
            {g.tools.map((t) => (
              <ToolRow key={t.name} tool={t} disabled={busy} onPolicy={(next) => policy.run((id) => setPolicy(id, t.name, next))} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function ToolRow({ tool: t, disabled, onPolicy }: { tool: IntegrationTool; disabled: boolean; onPolicy: (p: ToolPolicy) => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <code className="truncate font-mono text-xs">{t.name}</code>
        {t.description && (
          <span className="truncate text-xs text-muted-foreground" title={t.description}>
            {t.description}
          </span>
        )}
      </div>
      <ToggleGroup
        size="sm"
        variant="outline"
        aria-label={`${t.name} policy`}
        disabled={disabled}
        value={[t.policy]}
        onValueChange={(values: string[]) => {
          const policy = POLICIES.find((p) => p.value === values[0])?.value;
          if (policy && policy !== t.policy) onPolicy(policy);
        }}
      >
        {POLICIES.map((p) => (
          <ToggleGroupItem key={p.value} value={p.value} className="px-2 text-xs">
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </li>
  );
}
