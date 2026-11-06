import type { Integration } from "@claudebot/contract/events";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { setIntegrationEnabled } from "./api.ts";
import { SignInButton } from "./auth.tsx";
import { Connection } from "./connection.tsx";
import { DangerZone } from "./danger-zone.tsx";
import { Details } from "./details.tsx";
import { health, isOneClick, isSetUp } from "./model.ts";
import { HealthLabel, IntegrationIcon, useIntegrationAction } from "./parts.tsx";
import { Permissions } from "./permissions.tsx";
import { Skills } from "./skills.tsx";
import { TryIt } from "./try-it.tsx";

/** Everything about one integration: connection, per-tool permissions, skills, and the actions that remove it. */
export function IntegrationDetail({
  integration: i,
  onBack,
  onTry,
}: {
  integration: Integration;
  onBack: () => void;
  onTry: ((prompt: string) => void) | undefined;
}) {
  const examples = i.catalog?.examples ?? [];
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <Header integration={i} onBack={onBack} />
      <Connection integration={i} />
      {i.tools.length > 0 && <Permissions integration={i} />}
      {(i.skills.length > 0 || i.skillsError) && <Skills integration={i} />}
      {onTry && examples.length > 0 && i.state === "connected" && i.enabled && (
        <TryIt examples={examples} onTry={onTry} />
      )}
      <Details integration={i} />
      <DangerZone integration={i} />
    </div>
  );
}

/** Whether the one-button sign-in belongs in the header: a lost grant with a client the host can reuse, or a first one-click connect. */
const headerSignIn = (i: Integration) =>
  i.state === "needs-auth"
    ? i.auth.kind === "oauth" || (i.auth.kind === "bearer" && !!i.auth.ownClient)
    : i.state === "disconnected" && isOneClick(i.auth);

function Header({ integration: i, onBack }: { integration: Integration; onBack: () => void }) {
  const { busy, run } = useIntegrationAction(i.id);
  const setEnabled = (enabled: boolean) => run((id) => setIntegrationEnabled(id, enabled));
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 self-start"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" />
        Integrations
      </Button>
      <div className="flex flex-wrap items-start gap-4">
        <IntegrationIcon integration={i} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{i.label}</h2>
            {isSetUp(i) && <HealthLabel health={health(i)} pill />}
          </div>
          <p className="text-muted-foreground text-sm">
            {i.catalog?.tagline ?? "Custom MCP server"}
          </p>
          <p className="text-muted-foreground text-xs">
            {!i.enabled
              ? "Switched off: no bot gets these tools until you resume. Sign-in and settings are kept."
              : i.state === "connected"
                ? "Every bot can use these tools. Changes apply on each bot's next turn."
                : "Once connected, every bot can use its tools."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isSetUp(i) &&
            (i.enabled ? (
              <Button variant="outline" disabled={busy} onClick={() => setEnabled(false)}>
                {busy && <Spinner data-icon="inline-start" />}
                Pause
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setEnabled(true)}>
                {busy && <Spinner data-icon="inline-start" />}
                Resume
              </Button>
            ))}
          {headerSignIn(i) && (
            <SignInButton integration={i}>
              {i.state === "needs-auth" ? "Sign in" : `Connect ${i.label}`}
            </SignInButton>
          )}
        </div>
      </div>
    </div>
  );
}
