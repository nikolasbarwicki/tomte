import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Integration } from "@claudebot/contract/events";
import { dateTime } from "@/lib/format.ts";
import { Alternative, OwnClientForm, SignInButton, TokenForm } from "./auth.tsx";
import { ago, canProbe, effort, health, host, isSetUp } from "./model.ts";
import { HealthLabel, Row, Section, useIntegrationAction } from "./parts.tsx";
import { probe } from "./api.ts";

export function Connection({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  return (
    <Section
      title="Connection"
      action={
        canProbe(i) && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(probe)}>
            {busy && <Spinner data-icon="inline-start" />}
            {i.state === "connected" ? "Refresh tools" : i.state === "failed" ? "Retry" : "Reconnect"}
          </Button>
        )
      }
    >
      <dl className="divide-y">
        <Row label="Status">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <HealthLabel health={isSetUp(i) ? health(i) : "not-connected"} />
            {isSetUp(i) && (
              <span className="text-xs text-muted-foreground" title={dateTime(i.updatedAt)}>
                · updated {ago(i.updatedAt)}
              </span>
            )}
          </span>
        </Row>
        <Row label="Server">
          <span className="font-mono text-xs">{host(i)}</span>
        </Row>
        <Row label="Sign-in">{effort(i.auth)}</Row>
      </dl>
      {i.error && (
        <div className="border-t p-4">
          <Alert variant="destructive">
            <AlertDescription className="break-words">{i.error}</AlertDescription>
          </Alert>
        </div>
      )}
      {i.state !== "connected" && (
        <div className="flex flex-col gap-4 border-t p-4 empty:hidden">
          <ConnectFlow integration={i} />
        </div>
      )}
    </Section>
  );
}

/** The forms that connect a service which is not connected; a single sign-in button is the header's job. */
function ConnectFlow({ integration: i }: { integration: Integration }) {
  const a = i.auth;
  switch (a.kind) {
    case "none":
      return null;
    case "oauth":
      if (a.client === "own")
        return i.state === "needs-auth" ? (
          <Alternative label={`Use a different ${a.ownClient.appLabel}`}>
            <OwnClientForm integration={i} ownClient={a.ownClient} />
          </Alternative>
        ) : (
          <OwnClientForm integration={i} ownClient={a.ownClient} />
        );
      return (
        <>
          {i.state === "failed" && (
            <SignInButton integration={i} variant="outline" className="self-start">
              Sign in again
            </SignInButton>
          )}
          {a.alternative && (
            <Alternative label={`Use an ${a.alternative.tokenLabel} instead`}>
              <TokenForm integration={i} />
            </Alternative>
          )}
        </>
      );
    case "bearer":
      return (
        <>
          <TokenForm integration={i} />
          {a.ownClient && (
            <Alternative label="Use OAuth with your own app instead">
              <OwnClientForm integration={i} ownClient={a.ownClient} />
            </Alternative>
          )}
        </>
      );
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}
