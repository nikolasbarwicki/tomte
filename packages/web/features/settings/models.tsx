import type { ModelProvider } from "@claudebot/contract/api";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";

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
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { loadProviders } from "./api.ts";

const STATUS: Record<ModelProvider["status"], { label: string; className: string }> = {
  connected: {
    label: "Connected",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  disconnected: { label: "Not signed in", className: "bg-destructive/10 text-destructive" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground" },
};

const accessLine = (p: ModelProvider) =>
  p.access === "subscription"
    ? `${p.name} subscription, through the ${p.name} CLI`
    : `${p.name} API key`;

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
  useEffect(refresh, [refresh]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs">
          Sign-in is checked each time you open or refresh this page.
        </p>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={refresh}>
          {refreshing ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Refresh
        </Button>
      </div>
      {error && <p className="text-destructive text-sm break-words">{error}</p>}
      {providers?.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
      <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
        Other providers will appear here when the host supports them.
      </p>
    </div>
  );
}

function ProviderCard({ provider: p }: { provider: ModelProvider }) {
  const status = STATUS[p.status];
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
        {p.detail && (
          <p className="text-muted-foreground font-mono text-xs break-words">{p.detail}</p>
        )}
        {p.status !== "connected" && p.connect && (
          <div className="bg-muted/50 grid gap-1 rounded-lg p-3">
            <span className="text-xs font-medium">How to sign in</span>
            <code className="font-mono text-xs break-words whitespace-pre-wrap">{p.connect}</code>
          </div>
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
      </CardContent>
    </Card>
  );
}
