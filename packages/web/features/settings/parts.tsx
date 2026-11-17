import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A titled block of a Settings section: a small heading, an optional line under it, then its cards or rows. */
export function Group({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid grid-cols-1 gap-2", className)}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A label with its value on one line of a card; the value is mono when it is a path or an id. */
export function Row({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground w-28 shrink-0 text-sm">{label}</dt>
      <dd className={cn("min-w-0 flex-1 text-sm break-words", mono && "font-mono text-xs")}>
        {children}
      </dd>
    </div>
  );
}
