import { useState, type ReactNode } from "react";
import type { Integration } from "../events.ts";
import { act } from "../api.ts";
import { cn } from "@/lib/utils";
import type { Health } from "./model.ts";

/** A brand tile for built-ins; custom servers get their first letter. */
export function IntegrationIcon({ integration: i, size = "md" }: { integration: Integration; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-12 rounded-xl" : "size-9 rounded-lg";
  if (!i.catalog?.icon)
    return (
      <span aria-hidden className={cn("flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground ring-1 ring-foreground/10", box, size === "lg" ? "text-lg" : "text-sm")}>
        {i.label.charAt(0).toUpperCase()}
      </span>
    );
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center ring-1 ring-foreground/10", box)} style={{ backgroundColor: i.catalog.icon.color }}>
      <svg viewBox="0 0 24 24" className={size === "lg" ? "size-6" : "size-[18px]"} fill="white">
        <path d={i.catalog.icon.path} />
      </svg>
    </span>
  );
}

const HEALTH: Record<Health, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  paused: { label: "Paused", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  "needs-auth": { label: "Needs sign-in", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
  "not-connected": { label: "Not connected", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
};

/** A coloured dot and label; `pill` draws the outlined chip used in the detail header. */
export function HealthLabel({ health, pill, children }: { health: Health; pill?: boolean; children?: ReactNode }) {
  const h = HEALTH[health];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium", h.text, pill && "h-6 shrink-0 rounded-full border px-2.5")}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", h.dot)} />
      <span className="truncate">
        {h.label}
        {children}
      </span>
    </span>
  );
}

/** A titled block of the detail page: the title sits outside, the content on one rounded surface. */
export function Section({ title, description, action, children, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>
      <div className={cn("rounded-xl border bg-card text-card-foreground", className)}>{children}</div>
    </section>
  );
}

/** Posts an integration action for `id`; `busy` is true while one is in flight. */
export function useIntegrationAction(id: string) {
  const [busy, setBusy] = useState(false);
  const run = async (path: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    const ok = await act(path, { id, ...extra });
    setBusy(false);
    return ok;
  };
  return { busy, run };
}
