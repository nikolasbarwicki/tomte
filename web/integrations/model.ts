import { CATALOG_CATEGORIES, type CatalogCategory, type Integration, type IntegrationAuth, type IntegrationTool, type IntegrationTransport, type ToolPolicy } from "../events.ts";

export const TRANSPORT_LABEL: Record<IntegrationTransport["type"], string> = { http: "HTTP", sse: "SSE", stdio: "Local command" };

/** Switched on but failed or signed out: what the sidebar badge counts and the list sorts first. */
export const needsAttention = (i: Integration) => i.enabled && (i.state === "failed" || i.state === "needs-auth");

/** A custom server is always the user's; a built-in is once it has left `disconnected`. */
export const isSetUp = (i: Integration) => i.catalogId === null || i.state !== "disconnected";

/** What the user sees about a set-up integration. Paused hides only a healthy connection; a broken one still shows as broken. */
export type Health = "connected" | "paused" | "needs-auth" | "failed" | "not-connected";

export function health(i: Integration): Health {
  if (!i.enabled && i.state === "connected") return "paused";
  switch (i.state) {
    case "connected":
      return "connected";
    case "needs-auth":
      return "needs-auth";
    case "failed":
      return "failed";
    case "disconnected":
      return "not-connected";
    default: {
      const _exhaustive: never = i.state;
      return _exhaustive;
    }
  }
}

/** How much work connecting takes, so the user knows before pressing Connect. */
export function effort(auth: IntegrationAuth): string {
  switch (auth.kind) {
    case "none":
      return "No sign-in";
    case "bearer":
      return auth.ownClient ? "Token or own OAuth app" : "Token";
    case "oauth":
      return auth.client === "dcr" ? "One-click sign-in" : `Own OAuth app · ${auth.ownClient.steps.length} steps`;
    default: {
      const _exhaustive: never = auth;
      return _exhaustive;
    }
  }
}

/** Connecting needs nothing but a click: the provider registers the client itself. */
export const isOneClick = (auth: IntegrationAuth) => auth.kind === "oauth" && auth.client === "dcr";

/** Probing works once connected, after a failure, and for a custom server that needs no sign-in. */
export const canProbe = (i: Integration) => i.state === "connected" || i.state === "failed" || (i.auth.kind === "none" && i.catalogId === null);

export const endpoint = (i: Integration) =>
  i.transport.type === "stdio" ? [i.transport.command, ...i.transport.args, ...i.transport.envKeys.map((k) => `${k}=•••`)].join(" ") : i.transport.url;

export const host = (i: Integration) => {
  if (i.transport.type === "stdio") return i.transport.command;
  try {
    return new URL(i.transport.url).host;
  } catch {
    return i.transport.url;
  }
};

/** Why a row matched a search that its name and tagline did not. */
export type Hit = { kind: "tool" | "skill"; name: string };
export type ListEntry = { integration: Integration; hit: Hit | null };

const byLabel = (a: ListEntry, b: ListEntry) => a.integration.label.localeCompare(b.integration.label);

/** Splits the list into the user's integrations (attention first, then by name) and the built-ins not set up yet, both filtered by `query`. */
export function listSections(integrations: Integration[], query: string): { yours: ListEntry[]; available: ListEntry[] } {
  const q = query.trim().toLowerCase();
  const entries: ListEntry[] = [];
  for (const integration of integrations) {
    const entry = match(integration, q);
    if (entry) entries.push(entry);
  }
  const yours = entries.filter((e) => isSetUp(e.integration));
  const available = entries.filter((e) => !isSetUp(e.integration));
  yours.sort((a, b) => Number(needsAttention(b.integration)) - Number(needsAttention(a.integration)) || byLabel(a, b));
  available.sort(byLabel);
  return { yours, available };
}

/** Built-ins still to connect, one group per category in `CATALOG_CATEGORIES` order; empty groups are left out. */
export function byCategory(available: ListEntry[]): { category: CatalogCategory; entries: ListEntry[] }[] {
  return CATALOG_CATEGORIES.map((category) => ({ category, entries: available.filter((e) => e.integration.catalog?.category === category) })).filter((g) => g.entries.length > 0);
}

function match(integration: Integration, q: string): ListEntry | undefined {
  const has = (s: string) => s.toLowerCase().includes(q);
  if (!q || has(integration.label) || has(integration.name) || (integration.catalog && has(integration.catalog.tagline))) return { integration, hit: null };
  const tool = integration.tools.find((t) => has(t.name));
  if (tool) return { integration, hit: { kind: "tool", name: tool.name } };
  const skill = integration.skills.find((k) => has(k.name));
  if (skill) return { integration, hit: { kind: "skill", name: skill.name } };
}

/** What a tool can do, from the annotations its server declared. */
export type ToolKind = "read" | "write" | "destructive";
export const TOOL_KINDS: { kind: ToolKind; label: string; hint: string }[] = [
  { kind: "read", label: "Read", hint: "Only look things up" },
  { kind: "write", label: "Write", hint: "Create or change things" },
  { kind: "destructive", label: "Destructive", hint: "May delete or overwrite" },
];

export const toolKind = (t: IntegrationTool): ToolKind => (t.readOnly ? "read" : t.destructive ? "destructive" : "write");

/** Tools matching `query`, grouped by kind in `TOOL_KINDS` order; empty groups are left out. */
export function toolGroups(tools: IntegrationTool[], query: string) {
  const q = query.trim().toLowerCase();
  const shown = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : tools;
  return TOOL_KINDS.map((k) => ({ ...k, tools: shown.filter((t) => toolKind(t) === k.kind) })).filter((g) => g.tools.length > 0);
}

export function policyCounts(tools: IntegrationTool[]): Record<ToolPolicy, number> {
  const counts: Record<ToolPolicy, number> = { off: 0, ask: 0, auto: 0 };
  for (const t of tools) counts[t.policy]++;
  return counts;
}

/** "3 minutes ago"-style age of `t`; coarse on purpose, it labels when the state last changed. */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (s < 60) return "just now";
  if (s < 3600) return fmt.format(-Math.round(s / 60), "minute");
  if (s < 86_400) return fmt.format(-Math.round(s / 3600), "hour");
  return fmt.format(-Math.round(s / 86_400), "day");
}
