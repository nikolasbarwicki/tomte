import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { Integration } from "@tomte/contract/events";

import { Switch } from "@/components/ui/switch";

import { setSkillEnabled } from "./api.ts";
import { Section, useIntegrationAction } from "./parts.tsx";

export function Skills({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  const repo = i.catalog?.skillsRepo;
  const dir = i.transport.skillsDir;
  return (
    <Section
      title="Skills"
      description={
        repo ? (
          <a
            href={repo}
            target="_blank"
            rel="noreferrer"
            className="text-link inline-flex items-center gap-1"
          >
            From {repo.replace(/^https:\/\//, "")}
            <ArrowSquareOutIcon className="size-3" />
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
      {i.skillsError && (
        <p className="text-destructive border-b p-4 text-sm break-words">{i.skillsError}</p>
      )}
      <ul className="divide-y">
        {i.skills.map((k) => {
          const id = `${i.id}-skill-${k.name}`;
          return (
            <li key={k.name} className="flex items-start gap-3 px-4 py-2.5">
              <Switch
                id={id}
                className="mt-0.5"
                checked={k.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  run((integrationId) => setSkillEnabled(integrationId, k.name, enabled))
                }
              />
              <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                <code className="font-mono text-xs">{k.name}</code>
                {k.description && (
                  <span className="text-muted-foreground text-xs">{k.description}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
