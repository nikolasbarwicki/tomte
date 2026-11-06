import { useState, type ReactNode } from "react";
import { ArrowRight, ChevronLeft, ExternalLink, Info, Search } from "lucide-react";
import type { Integration, IntegrationTool, ToolPolicy } from "../events.ts";
import { confirmAction } from "../confirm.tsx";
import { dateTime } from "../format.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Alternative, OwnClientForm, SignInButton, TokenForm } from "./auth.tsx";
import { TRANSPORT_LABEL, ago, canProbe, effort, endpoint, health, host, isOneClick, isSetUp, policyCounts, toolGroups } from "./model.ts";
import { HealthLabel, IntegrationIcon, Section, useIntegrationAction } from "./parts.tsx";

const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

/** Everything about one integration: connection, per-tool permissions, skills, and the actions that remove it. */
export function IntegrationDetail({ integration: i, onBack, onTry }: { integration: Integration; onBack: () => void; onTry: ((prompt: string) => void) | undefined }) {
  const examples = i.catalog?.examples ?? [];
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <Header integration={i} onBack={onBack} />
      <Connection integration={i} />
      {i.tools.length > 0 && <Permissions integration={i} />}
      {(i.skills.length > 0 || i.skillsError) && <Skills integration={i} />}
      {onTry && examples.length > 0 && i.state === "connected" && i.enabled && <TryIt examples={examples} onTry={onTry} />}
      <Details integration={i} />
      <DangerZone integration={i} />
    </div>
  );
}

/** Whether the one-button sign-in belongs in the header: a lost grant with a client the host can reuse, or a first one-click connect. */
const headerSignIn = (i: Integration) =>
  i.state === "needs-auth" ? i.auth.kind === "oauth" || (i.auth.kind === "bearer" && !!i.auth.ownClient) : i.state === "disconnected" && isOneClick(i.auth);

function Header({ integration: i, onBack }: { integration: Integration; onBack: () => void }) {
  const { busy, run } = useIntegrationAction(i.id);
  const setEnabled = (enabled: boolean) => run("/api/integrations/set-enabled", { enabled });
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="-ml-2 self-start text-muted-foreground" onClick={onBack}>
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
          <p className="text-sm text-muted-foreground">{i.catalog?.tagline ?? "Custom MCP server"}</p>
          <p className="text-xs text-muted-foreground">
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
                Pause
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setEnabled(true)}>
                Resume
              </Button>
            ))}
          {headerSignIn(i) && <SignInButton integration={i}>{i.state === "needs-auth" ? "Sign in" : `Connect ${i.label}`}</SignInButton>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Connection({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  return (
    <Section
      title="Connection"
      action={
        canProbe(i) && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run("/api/integrations/probe")}>
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

function Permissions({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  const [query, setQuery] = useState("");
  const counts = policyCounts(i.tools);
  const groups = toolGroups(i.tools, query);
  return (
    <Section
      title="Permissions"
      description={`${i.tools.length} ${i.tools.length === 1 ? "tool" : "tools"} · ${counts.auto} Auto · ${counts.ask} Ask · ${counts.off} Off`}
      action={
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={busy} onClick={() => run("/api/integrations/reset-policies")} />}>Reset to defaults</TooltipTrigger>
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
              <ToolRow key={t.name} tool={t} disabled={busy} onPolicy={(policy) => run("/api/integrations/set-policy", { tool: t.name, policy })} />
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

function Skills({ integration: i }: { integration: Integration }) {
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
              <Switch id={id} className="mt-0.5" checked={k.enabled} disabled={busy} onCheckedChange={(enabled) => run("/api/integrations/set-skill-enabled", { skill: k.name, enabled })} />
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

function TryIt({ examples, onTry }: { examples: string[]; onTry: (prompt: string) => void }) {
  return (
    <Section title="Try it" description="Opens a chat with the prompt filled in; nothing is sent until you send it.">
      <ul className="divide-y">
        {examples.map((p) => (
          <li key={p}>
            <button type="button" onClick={() => onTry(p)} className="group flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
              <span className="min-w-0 flex-1">“{p}”</span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Details({ integration: i }: { integration: Integration }) {
  return (
    <Section title="Details">
      <dl className="divide-y">
        <Row label="Server">
          <span className="font-mono text-xs break-all">{endpoint(i)}</span>
        </Row>
        <Row label="Transport">{TRANSPORT_LABEL[i.transport.type]}</Row>
        <Row label="Tool names">
          <code className="font-mono text-xs">mcp__{i.name}__…</code>
        </Row>
        <Row label="Source">{i.catalogId === null ? "Custom server" : "Built-in catalog"}</Row>
        {i.catalogId === null && <Row label="Added">{dateTime(i.createdAt)}</Row>}
      </dl>
    </Section>
  );
}

function DangerZone({ integration: i }: { integration: Integration }) {
  const { busy, run } = useIntegrationAction(i.id);
  const custom = i.catalogId === null;
  const connected = i.state !== "disconnected";
  if (!custom && !connected) return null;
  const confirmed = async (path: string, title: string, description: string, action: string) => {
    if (await confirmAction({ title, description, action, destructive: true })) await run(path);
  };
  return (
    <Section title="Danger zone" className="divide-y border-destructive/30">
      {connected && (
        <DangerRow
          title={`Disconnect ${i.label}`}
          description="Deletes its secret from the keychain. Tool settings are kept, so reconnecting restores them."
          action="Disconnect"
          disabled={busy}
          onClick={() => confirmed("/api/integrations/disconnect", `Disconnect ${i.label}?`, "Its stored secret is deleted; tool settings are kept.", "Disconnect")}
        />
      )}
      {custom && (
        <DangerRow
          title={`Remove ${i.label}`}
          description="Deletes the server, its tool settings and its secrets. Adding it again starts from scratch."
          action="Remove"
          disabled={busy}
          onClick={() => confirmed("/api/integrations/remove", `Remove ${i.label}?`, "The server and its tool settings are deleted.", "Remove")}
        />
      )}
    </Section>
  );
}

function DangerRow({ title, description, action, disabled, onClick }: { title: string; description: string; action: string; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button variant="destructive" size="sm" disabled={disabled} onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
