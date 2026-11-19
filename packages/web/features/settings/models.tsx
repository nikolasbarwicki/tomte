import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import {
  ClaudeLongLivedToken,
  type ClaudeGatewayAuth,
  type ModelProvider,
} from "@tomte/contract/api";
import type { ClaudeState } from "@tomte/contract/host-status";
import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useHostStatus } from "@/host/hooks.ts";
import { cn } from "@/lib/utils";

import {
  cancelClaudeLogin,
  loadProviders,
  removeClaudeGateway,
  removeClaudeLongLivedToken,
  setClaudeGateway,
  setClaudeLongLivedToken,
  startClaudeLogin,
  submitClaudeLoginCode,
} from "./api.ts";
import { PlanUsage } from "./usage.tsx";

/** How often the page asks again while a sign-in waits, so one the CLI completes on its own shows. */
const LOGIN_POLL_MS = 3000;

const PROVIDER_OF_STATE: Record<ClaudeState, ModelProvider["status"]> = {
  "signed-in": "connected",
  "signed-out": "disconnected",
  unknown: "unknown",
};
const STATUS: Record<ModelProvider["status"], { label: string; className: string }> = {
  connected: {
    label: "Ready for your bots",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  disconnected: { label: "Not signed in", className: "bg-destructive/10 text-destructive" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground" },
};

const AUTH_LABEL: Record<ClaudeGatewayAuth, string> = {
  bearer: "Bearer token",
  api_key: "API key",
};
const AUTHS = Object.entries(AUTH_LABEL).map(([value, label]) => ({ value, label }));
const isAuth = (v: string): v is ClaudeGatewayAuth => v in AUTH_LABEL;

const accessLine = (p: ModelProvider) =>
  p.access === "subscription"
    ? `${p.name} subscription, through the ${p.name} CLI`
    : `Custom provider, through the ${p.name} CLI`;

/** How each way of using Claude is billed and what its terms say; every method on this page shows both lines. */
const METHOD_NOTES = {
  signIn: {
    billing: "Billed to your Claude plan: bots use its session and weekly limits.",
    terms:
      "Terms risk: Anthropic's consumer terms restrict automated access (a bot or a script) unless Anthropic permits it. Whether running bots on your plan is covered is your decision.",
  },
  longLivedToken: {
    billing: "Billed to your Claude plan, like signing in: bots use its session and weekly limits.",
    terms:
      "Terms risk: the same as signing in, and the token is a credential of your account that stays valid until it expires or you revoke it. Anthropic's consumer terms restrict automated access (a bot or a script) unless Anthropic permits it; whether running bots on your plan is covered is your decision.",
  },
  sshCommand: {
    billing: "Billed to your Claude plan, like signing in: bots use its session and weekly limits.",
    terms:
      "Terms risk: the same as signing in. The sign-in happens in a terminal on the host, so no code or token passes through this page.",
  },
  customProvider: {
    billing: "Billed by your provider for what bots use, not to a Claude plan.",
    terms:
      "Terms risk: your provider's terms apply, not Anthropic's consumer terms. Check that they allow how you use it.",
  },
} as const;

function MethodNotes({ notes }: { notes: { billing: string; terms: string } }) {
  return (
    <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      <li>{notes.billing}</li>
      <li>{notes.terms}</li>
    </ul>
  );
}

/** The billing variables the host started with and does not pass on, with what to do instead. */
function IgnoredEnv({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div
      role="note"
      data-ignored-env={names.join(" ")}
      className="bg-muted/50 flex flex-col gap-1 rounded-lg p-3 text-sm"
    >
      <p className="break-words">
        Ignored in this host's environment:{" "}
        {names.map((n, i) => (
          <span key={n}>
            {i > 0 && ", "}
            <span className="font-mono text-xs">{n}</span>
          </span>
        ))}
        .
      </p>
      <p className="text-muted-foreground text-xs">
        Bots never use these, so nothing is billed through them by accident. To sign in, use Sign
        in. To bill by API on purpose, use the custom provider.
      </p>
    </div>
  );
}

const accountLine = (p: ModelProvider) =>
  [
    p.account && `Signed in as ${p.account.email ?? p.account.method}`,
    p.account?.organization,
    p.account?.plan,
    p.cliVersion && `v${p.cliVersion}`,
  ]
    .filter(Boolean)
    .join(" · ");

/** Models: the providers bots run on and whether the host is signed in to each. */
export function Models() {
  const [providers, setProviders] = useState<ModelProvider[]>();
  const [error, setError] = useState<string>();
  const [refreshing, startRefreshing] = useTransition();

  const refresh = useCallback(
    () =>
      startRefreshing(async () => {
        try {
          setProviders(await loadProviders());
          setError(undefined);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }),
    [],
  );
  // The host announces a sign-in or sign-out as it happens; the page asks again for the account that goes with it.
  const claudeState = useHostStatus()?.claude.state;
  useEffect(refresh, [refresh, claudeState]);
  const loginPending = providers?.some((p) => p.login) ?? false;
  useEffect(() => {
    if (!loginPending) return;
    const timer = setInterval(refresh, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [loginPending, refresh]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs">
          Sign-in is checked every few minutes and whenever the CLI's credentials change; Refresh
          checks now. Bots never load your own Claude Code settings, CLAUDE.md, hooks, plugins,
          skills or claude.ai connectors.
        </p>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={refresh}>
          {refreshing ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowsClockwiseIcon data-icon="inline-start" />
          )}
          Refresh
        </Button>
      </div>
      {error && <p className="text-destructive text-sm break-words">{error}</p>}
      {providers?.map((p) => (
        <ProviderCard key={p.id} provider={p} onChange={refresh} />
      ))}
      <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
        Other providers will appear here when the host supports them.
      </p>
    </div>
  );
}

function ProviderCard({
  provider: listed,
  onChange,
}: {
  provider: ModelProvider;
  onChange: () => void;
}) {
  const live = useHostStatus()?.claude;
  const p =
    listed.id === "claude" && live ? { ...listed, status: PROVIDER_OF_STATE[live.state] } : listed;
  const status = STATUS[p.status];
  const account = accountLine(p);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {p.name} <span className="text-muted-foreground text-xs font-normal">by {p.vendor}</span>
        </CardTitle>
        <CardDescription>{accessLine(p)}</CardDescription>
        <CardAction>
          <Badge variant="secondary" className={cn(status.className)}>
            {status.label}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {account && <p className="text-sm break-words">{account}</p>}
        {p.detail && (
          <p className="text-muted-foreground font-mono text-xs break-words">{p.detail}</p>
        )}
        {p.id === "claude" && <IgnoredEnv names={live?.ignoredEnv ?? []} />}
        {!p.gateway && !p.longLivedToken && (
          <>
            <MethodNotes notes={METHOD_NOTES.signIn} />
            <SignIn provider={p} onChange={onChange} />
            <PasteToken onChange={onChange} />
            {p.sshCommand && <SshCommand command={p.sshCommand} />}
          </>
        )}
        {!p.gateway && p.longLivedToken && (
          <LongLivedToken rejected={live?.reason === "token-rejected"} onChange={onChange} />
        )}
        {p.models.length > 0 && (
          <ul aria-label={`${p.name} models`} className="flex flex-wrap gap-1.5">
            {p.models.map((m) => (
              <li key={m} className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-xs">
                {m}
              </li>
            ))}
          </ul>
        )}
        {p.status === "connected" && !p.gateway && !p.longLivedToken && !p.login && (
          <PlanUsage revision={p} />
        )}
        <CustomProvider provider={p} onChange={onChange} />
      </CardContent>
    </Card>
  );
}

/** The sign-in button, and while a sign-in waits, its page and the code field. */
function SignIn({ provider: p, onChange }: { provider: ModelProvider; onChange: () => void }) {
  const [starting, startStarting] = useTransition();
  const [code, setCode] = useState("");
  const [failure, submit, busy] = useActionState(async () => {
    const reason = await submitClaudeLoginCode(code);
    if (reason !== undefined) return reason;
    setCode("");
    toast.success(`${p.name} is signed in`);
    onChange();
    return "";
  }, "");
  const error = busy ? "" : failure;

  if (!p.login)
    return (
      <div className="flex flex-col gap-2">
        {p.status !== "connected" && p.connect && (
          <p className="text-muted-foreground text-xs break-words">{p.connect}</p>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onClick={() =>
              startStarting(async () => {
                if ((await startClaudeLogin()) !== undefined) onChange();
              })
            }
          >
            {starting && <Spinner data-icon="inline-start" />}
            {p.status === "connected" ? "Sign in again" : "Sign in"}
          </Button>
        </div>
      </div>
    );

  return (
    <form action={submit} className="bg-muted/50 rounded-lg p-3">
      <FieldGroup className="gap-3">
        <p className="text-sm break-words">
          Open{" "}
          <a href={p.login.url} target="_blank" rel="noreferrer" className="underline">
            the {p.name} sign-in page
          </a>
          , then paste the code it shows. A sign-in finished in this computer's browser shows here
          on its own.
        </p>
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="claude-login-code">Code</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="claude-login-code"
              autoComplete="off"
              aria-invalid={!!error || undefined}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !code.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              Submit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void cancelClaudeLogin().then(onChange)}
            >
              Cancel
            </Button>
          </div>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  );
}

/** The command that signs the host in from a terminal on it. */
function SshCommand({ command }: { command: string }) {
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <span className="text-xs font-medium">SSH command: sign in from a terminal on the host</span>
      <code className="bg-muted rounded-md p-2 font-mono text-xs break-words">{command}</code>
      <MethodNotes notes={METHOD_NOTES.sshCommand} />
    </div>
  );
}

/** The form that sets a long-lived token. The token is sent once and never shown again. */
function PasteToken({ onChange }: { onChange: () => void }) {
  const [token, setToken] = useState("");
  const [, submit, busy] = useActionState(async () => {
    const reason = await setClaudeLongLivedToken(token);
    setToken("");
    onChange();
    if (reason !== undefined) toast.error(reason);
    else toast.success("Long-lived token saved");
    return "";
  }, "");
  const shape = token.trim() ? ClaudeLongLivedToken.safeParse({ token }) : undefined;
  const invalid = shape?.success === false ? shape.error.issues[0]?.message : undefined;

  return (
    <form action={submit} className="border-t pt-3">
      <FieldGroup className="gap-3">
        <span className="text-xs font-medium">
          Paste a long-lived token: run <span className="font-mono">claude setup-token</span> on a
          computer where you are signed in to Claude
        </span>
        <MethodNotes notes={METHOD_NOTES.longLivedToken} />
        <Field data-invalid={invalid !== undefined}>
          <FieldLabel htmlFor="claude-long-lived-token">Token</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="claude-long-lived-token"
              type="password"
              autoComplete="off"
              aria-invalid={invalid !== undefined}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || !token.trim() || invalid !== undefined}
            >
              {busy && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
          {invalid !== undefined && <FieldError>{invalid}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  );
}

/** The long-lived token in use, with its Remove button. The token itself is never shown. */
function LongLivedToken({ rejected, onChange }: { rejected: boolean; onChange: () => void }) {
  const [removing, startRemoving] = useTransition();
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm break-words">
          {rejected ? "Long-lived token rejected by Claude" : "Long-lived token in use"}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={removing}
          onClick={() =>
            startRemoving(async () => {
              if (await removeClaudeLongLivedToken()) onChange();
            })
          }
        >
          {removing && <Spinner data-icon="inline-start" />}
          Remove
        </Button>
      </div>
      {rejected && (
        <p className="text-destructive text-xs break-words">
          Bots cannot run on it. Remove it, then paste a new one from{" "}
          <span className="font-mono">claude setup-token</span>.
        </p>
      )}
      <MethodNotes notes={METHOD_NOTES.longLivedToken} />
    </div>
  );
}

/** The custom provider in use with its Remove button, or the form that sets one. The token is sent once and never shown again. */
function CustomProvider({
  provider: p,
  onChange,
}: {
  provider: ModelProvider;
  onChange: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<ClaudeGatewayAuth>("bearer");
  const [token, setToken] = useState("");
  const [removing, startRemoving] = useTransition();
  const [failure, submit, busy] = useActionState(async () => {
    const reason = await setClaudeGateway({ baseUrl, auth, token });
    if (reason !== undefined) return reason;
    setToken("");
    toast.success("Custom provider saved");
    onChange();
    return "";
  }, "");
  const error = busy ? "" : failure;

  if (p.gateway)
    return (
      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm break-words">
            Custom provider: <span className="font-mono text-xs">{p.gateway.baseUrl}</span> (
            {AUTH_LABEL[p.gateway.auth]})
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={removing}
            onClick={() =>
              startRemoving(async () => {
                if (await removeClaudeGateway()) onChange();
              })
            }
          >
            {removing && <Spinner data-icon="inline-start" />}
            Remove
          </Button>
        </div>
        <MethodNotes notes={METHOD_NOTES.customProvider} />
      </div>
    );

  return (
    <form action={submit} className="border-t pt-3">
      <FieldGroup className="gap-3">
        <span className="text-xs font-medium">
          Custom provider: your own gateway or an Anthropic-compatible API, used instead of the
          sign-in
        </span>
        <MethodNotes notes={METHOD_NOTES.customProvider} />
        <Field>
          <FieldLabel htmlFor="claude-gateway-url">Base URL</FieldLabel>
          <Input
            id="claude-gateway-url"
            type="url"
            placeholder="https://gateway.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="claude-gateway-auth">Authentication</FieldLabel>
          <Select items={AUTHS} value={auth} onValueChange={(v) => v && isAuth(v) && setAuth(v)}>
            <SelectTrigger id="claude-gateway-auth" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTHS.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="claude-gateway-token">Token</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="claude-gateway-token"
              type="password"
              autoComplete="off"
              aria-invalid={!!error || undefined}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !baseUrl.trim() || !token.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  );
}
