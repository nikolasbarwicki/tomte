import { useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, ExternalLink, Plug, Plus, Search } from "lucide-react";
import type { Integration, OwnClient, ToolPolicy } from "./events.ts";
import { act, errorOf, post } from "./api.ts";
import { confirmAction } from "./confirm.tsx";
import { Page } from "./page.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATE_LABEL: Record<Integration["state"], string> = {
  disconnected: "Disconnected",
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
};

const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

type Transport = "http" | "sse" | "stdio";
const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "Local command" },
];

/** Opens the provider's sign-in page in `tab`, which the caller opened inside the click so the browser allows it. */
async function signIn(id: string, tab: Window | null, client?: { clientId: string; clientSecret: string }): Promise<string | undefined> {
  const r = await post("/api/integrations/connect-oauth", { id, ...client });
  if (!r.ok) {
    tab?.close();
    return errorOf(r);
  }
  const body = await r.json();
  if (tab) tab.location.href = body.authorizeUrl;
  else window.open(body.authorizeUrl, "_blank");
}

function StateBadge({ state }: { state: Integration["state"] }) {
  if (state === "connected")
    return (
      <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        {STATE_LABEL[state]}
      </Badge>
    );
  return <Badge variant={state === "disconnected" ? "secondary" : "destructive"}>{STATE_LABEL[state]}</Badge>;
}

/** The global Integrations screen; it replaces the chat and memory columns. */
export function Integrations({ integrations }: { integrations: Integration[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <Page
      title="Integrations"
      description="MCP servers and skills shared by every bot. Changes apply on each bot's next turn."
      actions={
        <Dialog open={adding} onOpenChange={setAdding}>
          <DialogTrigger render={<Button size="sm" />}>
            <Plus data-icon="inline-start" />
            Add custom server
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add custom MCP server</DialogTitle>
              <DialogDescription>Connect a remote server by URL, or run one locally as a command.</DialogDescription>
            </DialogHeader>
            {adding && <CustomForm onDone={() => setAdding(false)} />}
          </DialogContent>
        </Dialog>
      }
    >
      {integrations.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug />
            </EmptyMedia>
            <EmptyTitle>No integrations yet</EmptyTitle>
            <EmptyDescription>Add a custom MCP server to give your bots new tools and skills.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" />
              Add custom server
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {integrations.map((i) => (
            <IntegrationCard key={i.id} integration={i} />
          ))}
        </div>
      )}
    </Page>
  );
}

function IntegrationCard({ integration: i }: { integration: Integration }) {
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = i.tools.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const run = async (path: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    await act(path, { id: i.id, ...extra });
    setBusy(false);
  };
  const confirmed = async (path: string, title: string, description: string, action: string) => {
    if (await confirmAction({ title, description, action, destructive: true })) await run(path);
  };
  const endpoint = i.transport.type === "stdio" ? [i.transport.command, ...i.transport.args, ...i.transport.envKeys.map((k) => `${k}=•••`)].join(" ") : i.transport.url;
  const needsAuth = i.state !== "connected";
  const canProbe = i.state === "connected" || (i.auth.kind === "none" && i.catalogId === null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {i.label}
          <StateBadge state={i.state} />
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs" title={endpoint}>
          {i.transport.type.toUpperCase()} · {endpoint}
        </CardDescription>
        <CardAction>
          <Switch aria-label={`Enable ${i.label}`} checked={i.enabled} disabled={busy} onCheckedChange={(enabled) => run("/api/integrations/set-enabled", { enabled })} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {i.note && <p className="text-sm text-muted-foreground">{i.note}</p>}
        {i.error && (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{i.error}</AlertDescription>
          </Alert>
        )}
        {needsAuth && i.auth.kind === "oauth" && i.auth.client === "own" && <OwnClientForm integration={i} ownClient={i.auth.ownClient} />}
        {needsAuth && i.auth.kind === "oauth" && i.auth.client === "dcr" && (
          <Button
            className="self-start"
            disabled={busy}
            onClick={async () => {
              const tab = window.open("", "_blank");
              setBusy(true);
              const error = await signIn(i.id, tab);
              setBusy(false);
              if (error) toast.error(error);
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            Connect
          </Button>
        )}
        {needsAuth && i.auth.kind === "bearer" && <TokenForm integration={i} />}
        {needsAuth && i.auth.kind === "bearer" && i.auth.ownClient && (
          <Alternative label="Use OAuth with your own app instead">
            <OwnClientForm integration={i} ownClient={i.auth.ownClient} />
          </Alternative>
        )}
        {needsAuth && i.auth.kind === "oauth" && i.auth.alternative && (
          <Alternative label={`Use an ${i.auth.alternative.tokenLabel} instead`}>
            <TokenForm integration={i} />
          </Alternative>
        )}
        {i.tools.length > 0 && (
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">
              Tools <span className="font-normal text-muted-foreground">({i.tools.length})</span>
            </h4>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" placeholder="Filter tools" aria-label={`Filter ${i.name} tools`} className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={busy} onClick={() => run("/api/integrations/reset-policies")} />}>
                  Reset to defaults
                </TooltipTrigger>
                <TooltipContent>Read-only tools Auto, the rest Ask</TooltipContent>
              </Tooltip>
            </div>
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {shown.length === 0 && <li className="p-3 text-center text-sm text-muted-foreground">No tools match</li>}
              {shown.map((t) => (
                <li key={t.name} className="flex items-center gap-2 px-2.5 py-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <code className="truncate font-mono text-xs" title={t.description}>
                      {t.name}
                    </code>
                    {t.readOnly && <Badge variant="secondary">read-only</Badge>}
                    {t.destructive && <Badge variant="destructive">destructive</Badge>}
                  </div>
                  <ToggleGroup
                    size="sm"
                    variant="outline"
                    aria-label={`${t.name} policy`}
                    value={[t.policy]}
                    onValueChange={(values: string[]) => {
                      const policy = values[0] as ToolPolicy | undefined;
                      if (policy && policy !== t.policy) void run("/api/integrations/set-policy", { tool: t.name, policy });
                    }}
                  >
                    {POLICIES.map((p) => (
                      <ToggleGroupItem key={p.value} value={p.value} className="px-2 text-xs">
                        {p.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Ask tools are denied in scheduled routines; set Auto on tools a routine needs.</p>
          </section>
        )}
        {(i.skills.length > 0 || i.skillsError) && (
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Skills</h4>
            {i.skillsError && <p className="text-sm text-destructive">{i.skillsError}</p>}
            <ul className="flex flex-col gap-3">
              {i.skills.map((k) => {
                const id = `${i.id}-skill-${k.name}`;
                return (
                  <li key={k.name} className="flex items-start gap-3">
                    <Switch id={id} className="mt-0.5" checked={k.enabled} disabled={busy} onCheckedChange={(enabled) => run("/api/integrations/set-skill-enabled", { skill: k.name, enabled })} />
                    <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                      <code className="font-mono text-xs">{k.name}</code>
                      {k.description && <span className="text-xs text-muted-foreground">{k.description}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </CardContent>
      {(canProbe || i.state === "connected" || i.catalogId === null) && (
        <CardFooter className="flex flex-wrap gap-2">
          {canProbe && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run("/api/integrations/probe")}>
              {i.state === "connected" ? "Refresh tools" : i.state === "failed" ? "Retry" : "Reconnect"}
            </Button>
          )}
          {i.state === "connected" && (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => confirmed("/api/integrations/disconnect", `Disconnect ${i.label}?`, "Its stored secret is deleted; tool settings are kept.", "Disconnect")}
            >
              Disconnect
            </Button>
          )}
          {i.catalogId === null && (
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => confirmed("/api/integrations/remove", `Remove ${i.name}?`, "Its tool settings are deleted.", "Remove")}>
              Remove
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function Alternative({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="group self-start text-muted-foreground" />}>
        {label}
        <ChevronDown data-icon="inline-end" className="transition-transform group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-muted/50 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Copy redirect address"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          toast.success("Redirect address copied");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function OwnClientForm({ integration: i, ownClient }: { integration: Integration; ownClient: OwnClient }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    const tab = window.open("", "_blank");
    setBusy(true);
    const error = await signIn(i.id, tab, { clientId, clientSecret });
    setBusy(false);
    if (error) toast.error(error);
    else setClientSecret("");
  };
  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-4">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {ownClient.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <Field>
          <FieldLabel>Redirect address to register</FieldLabel>
          <CopyBlock value={i.redirectUrl} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${i.id}-client-id`}>Client ID</FieldLabel>
          <Input id={`${i.id}-client-id`} autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${i.id}-client-secret`}>Client secret</FieldLabel>
          <Input id={`${i.id}-client-secret`} type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        </Field>
        <Button type="submit" className="self-start" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
          {busy && <Spinner data-icon="inline-start" />}
          Connect
        </Button>
      </FieldGroup>
    </form>
  );
}

function TokenForm({ integration: i }: { integration: Integration }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const label = i.auth.kind === "bearer" ? i.auth : i.auth.kind === "oauth" ? i.auth.alternative : undefined;
  if (!label) return null;
  const submit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await post("/api/integrations/set-bearer", { id: i.id, token });
    setBusy(false);
    if (r.ok) return setToken("");
    setError(await errorOf(r));
  };
  const id = `${i.id}-token`;
  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-3">
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor={id}>{label.tokenLabel ?? "Bearer token"}</FieldLabel>
          <Input id={id} type="password" autoComplete="off" aria-invalid={!!error || undefined} value={token} onChange={(e) => setToken(e.target.value)} />
          {label.tokenUrl && (
            <FieldDescription>
              <a href={label.tokenUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                Get a {label.tokenLabel ?? "token"}
                <ExternalLink className="size-3" />
              </a>
            </FieldDescription>
          )}
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <Button type="submit" className="self-start" disabled={busy || !token.trim()}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function CustomForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [token, setToken] = useState("");
  const [oauth, setOauth] = useState(false);
  const [skillsDir, setSkillsDir] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    const wantsSignIn = oauth && transport !== "stdio";
    const tab = wantsSignIn ? window.open("", "_blank") : null;
    setBusy(true);
    setError("");
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const at = line.indexOf("=");
      if (line.trim() && at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    const r = await post(
      "/api/integrations/add-custom",
      transport === "stdio" ? { name, transport, command: url, args: args.split(/\s+/).filter(Boolean), env, skillsDir } : { name, url, transport, token: oauth ? undefined : token, oauth, skillsDir },
    );
    if (!r.ok) {
      tab?.close();
      setBusy(false);
      return setError(await errorOf(r));
    }
    const body = await r.json();
    const signInError = wantsSignIn ? await signIn(body.id, tab) : undefined;
    setBusy(false);
    if (signInError) return setError(signInError);
    onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="custom-name">Name</FieldLabel>
          <Input id="custom-name" placeholder="cfdocs" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="custom-transport">Transport</FieldLabel>
          <Select items={TRANSPORTS} value={transport} onValueChange={(v) => v && setTransport(v as Transport)}>
            <SelectTrigger id="custom-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {transport === "stdio" ? (
          <>
            <Field>
              <FieldLabel htmlFor="custom-command">Command</FieldLabel>
              <Input id="custom-command" placeholder="npx" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-args">Arguments</FieldLabel>
              <Input id="custom-args" placeholder="-y some-mcp-server" value={args} onChange={(e) => setArgs(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-env">Environment</FieldLabel>
              <Textarea id="custom-env" className="font-mono text-xs" placeholder="API_KEY=…" autoComplete="off" value={envText} onChange={(e) => setEnvText(e.target.value)} />
              <FieldDescription>One KEY=value per line. Values are stored in the keychain.</FieldDescription>
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="custom-url">URL</FieldLabel>
              <Input id="custom-url" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field orientation="horizontal">
              <Switch id="custom-oauth" checked={oauth} onCheckedChange={setOauth} />
              <FieldLabel htmlFor="custom-oauth">Sign in with OAuth</FieldLabel>
            </Field>
            {!oauth && (
              <Field>
                <FieldLabel htmlFor="custom-token">Bearer token</FieldLabel>
                <Input id="custom-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
                <FieldDescription>Optional.</FieldDescription>
              </Field>
            )}
          </>
        )}
        <Field>
          <FieldLabel htmlFor="custom-skills">Local skills folder</FieldLabel>
          <Input id="custom-skills" className="font-mono text-xs" placeholder="/Users/me/skills" value={skillsDir} onChange={(e) => setSkillsDir(e.target.value)} />
          <FieldDescription>Optional absolute path.</FieldDescription>
        </Field>
        {error && <FieldError className="break-words">{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Connecting…" : "Add server"}
        </Button>
      </DialogFooter>
    </form>
  );
}
