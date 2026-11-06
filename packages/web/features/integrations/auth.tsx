import { OAuthStart } from "@claudebot/contract/api";
import type { Integration, OwnClient } from "@claudebot/contract/events";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import {
  useActionState,
  useState,
  useTransition,
  type ComponentProps,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorOf, readJson } from "@/host/api.ts";

import { connectOauth, setBearer } from "./api.ts";

/** Opens the provider's sign-in page in `tab`, which the caller opened inside the click so the browser allows it. */
export async function signIn(
  id: string,
  tab: Window | null,
  client?: { clientId: string; clientSecret: string },
): Promise<string | undefined> {
  const r = await connectOauth(id, client);
  if (!r.ok) {
    tab?.close();
    return errorOf(r);
  }
  const body = await readJson(r, OAuthStart);
  if (tab) tab.location.href = body.authorizeUrl;
  else window.open(body.authorizeUrl, "_blank");
}

/** Starts OAuth sign-in with the client the host already has; `onRefused` gets the host's refusal. */
export function SignInButton({
  integration: i,
  children,
  onRefused = (e) => toast.error(e),
  ...props
}: { integration: Integration; children: ReactNode; onRefused?: (error: string) => void } & Omit<
  ComponentProps<typeof Button>,
  "onClick" | "children"
>) {
  const [busy, startTransition] = useTransition();
  return (
    <Button
      {...props}
      disabled={busy || props.disabled}
      onClick={() => {
        const tab = window.open("", "_blank");
        startTransition(async () => {
          const error = await signIn(i.id, tab);
          if (error) onRefused(error);
        });
      }}
    >
      {busy && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  );
}

export function Alternative({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible className="flex flex-col gap-3">
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="xs" className="group text-muted-foreground self-start" />
        }
      >
        {label}
        <ChevronDown
          data-icon="inline-end"
          className="transition-transform group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    toast.success("Redirect address copied");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="bg-muted/50 flex items-center gap-1 rounded-lg border py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Copy redirect address"
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Registering an OAuth client by hand: numbered steps, the redirect address to paste, then the client's ID and secret. */
export function OwnClientForm({
  integration: i,
  ownClient,
}: {
  integration: Integration;
  ownClient: OwnClient;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, startTransition] = useTransition();
  const submit = (e: React.SubmitEvent) => {
    e.preventDefault();
    const tab = window.open("", "_blank");
    startTransition(async () => {
      const error = await signIn(i.id, tab, { clientId, clientSecret });
      if (error) toast.error(error);
      else setClientSecret("");
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <ol className="flex flex-col">
        {ownClient.steps.map((s, n) => (
          <li key={s} className="relative flex gap-3 pb-4 last:pb-0">
            {n < ownClient.steps.length - 1 && (
              <span aria-hidden className="bg-border absolute top-6 bottom-0 left-2.75 w-px" />
            )}
            <span className="bg-background flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums">
              {n + 1}
            </span>
            <p className="text-muted-foreground pt-0.5 text-sm">{s}</p>
          </li>
        ))}
      </ol>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel>Redirect address to register</FieldLabel>
          <CopyBlock value={i.redirectUrl} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${i.id}-client-id`}>Client ID</FieldLabel>
            <Input
              id={`${i.id}-client-id`}
              autoComplete="off"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${i.id}-client-secret`}>Client secret</FieldLabel>
            <Input
              id={`${i.id}-client-secret`}
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </Field>
        </div>
        <Button
          type="submit"
          className="self-start"
          disabled={busy || !clientId.trim() !== !clientSecret.trim()}
        >
          {busy && <Spinner data-icon="inline-start" />}
          Connect {i.label}
        </Button>
      </FieldGroup>
    </form>
  );
}

export function TokenForm({ integration: i }: { integration: Integration }) {
  const [token, setToken] = useState("");
  const [failure, submit, busy] = useActionState(async () => {
    const r = await setBearer(i.id, token);
    if (r.ok) {
      setToken("");
      return "";
    }
    return errorOf(r);
  }, "");
  const error = busy ? "" : failure;
  const label =
    i.auth.kind === "bearer" ? i.auth : i.auth.kind === "oauth" ? i.auth.alternative : undefined;
  if (!label) return null;
  const id = `${i.id}-token`;
  return (
    <form action={submit}>
      <FieldGroup className="gap-3">
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor={id}>{label.tokenLabel ?? "Bearer token"}</FieldLabel>
          <Input
            id={id}
            type="password"
            autoComplete="off"
            aria-invalid={!!error || undefined}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {label.tokenUrl && (
            <FieldDescription>
              <a
                href={label.tokenUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1"
              >
                Create {label.tokenLabel ?? "a token"}
                <ExternalLink className="size-3" />
              </a>
            </FieldDescription>
          )}
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <Button type="submit" className="self-start" disabled={busy || !token.trim()}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Connecting…" : `Connect ${i.label}`}
        </Button>
      </FieldGroup>
    </form>
  );
}
