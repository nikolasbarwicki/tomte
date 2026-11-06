import { ExternalLink } from "lucide-react";
import type { Integration } from "@claudebot/contract/events";
import { Switch } from "@/components/ui/switch";
import { Section, useIntegrationAction } from "./parts.tsx";
import { setSkillEnabled } from "./api.ts";

export function Skills({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  const repo = i.catalog?.skillsRepo;
  const dir = i.transport.skillsDir;
  return (
    <Section
      title="Skills"
      description={
        repo ? (
          <a href={repo} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link">
            From {repo.replace(/^https:\/\//, "")}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          dir && (
            <>
              From <code className="font-mono">{dir}</code>
            </>
          )
        )
      }
    >
      {i.skillsError && <p className="border-b p-4 text-sm break-words text-destructive">{i.skillsError}</p>}
      <ul className="divide-y">
        {i.skills.map((k) => {
          const id = `${i.id}-skill-${k.name}`;
          return (
            <li key={k.name} className="flex items-start gap-3 px-4 py-2.5">
              <Switch id={id} className="mt-0.5" checked={k.enabled} disabled={busy} onCheckedChange={(enabled) => run((integrationId) => setSkillEnabled(integrationId, k.name, enabled))} />
              <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                <code className="font-mono text-xs">{k.name}</code>
                {k.description && <span className="text-xs text-muted-foreground">{k.description}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
