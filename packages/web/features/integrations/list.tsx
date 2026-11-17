import { CaretRightIcon, PlusIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { Integration } from "@tomte/contract/events";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { SignInButton } from "./auth.tsx";
import {
  byCategory,
  effort,
  health,
  host,
  isOneClick,
  isSetUp,
  listSections,
  type ListEntry,
} from "./model.ts";
import { HealthLabel, IntegrationIcon } from "./parts.tsx";

/** Every integration as one row each: the user's first, then the built-ins still to connect, grouped by category. Configuration lives on the detail page. */
export function IntegrationsList({
  integrations,
  onOpen,
}: {
  integrations: Integration[];
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const { yours, available } = listSections(integrations, query);
  return (
    <div className="flex flex-col gap-6">
      <div className="relative">
        <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          placeholder="Search integrations, tools and skills…"
          aria-label="Search integrations, tools and skills"
          className="h-9 pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {yours.length > 0 && <RowGroup title="Your integrations" entries={yours} onOpen={onOpen} />}
      {byCategory(available).map((g) => (
        <RowGroup key={g.category} title={g.category} entries={g.entries} onOpen={onOpen} />
      ))}
      {yours.length === 0 && available.length === 0 && (
        <p className="text-muted-foreground py-10 text-center text-sm">
          No integration, tool or skill matches “{query.trim()}”.
        </p>
      )}
    </div>
  );
}

function RowGroup({
  title,
  entries,
  onOpen,
}: {
  title: string;
  entries: ListEntry[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-sm font-medium">
        {title}{" "}
        <span className="text-muted-foreground font-normal tabular-nums">{entries.length}</span>
      </h2>
      <ul className="bg-card divide-y overflow-hidden rounded-xl border">
        {entries.map((e) => (
          <Row key={e.integration.id} entry={e} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function Row({
  entry: { integration: i, hit },
  onOpen,
}: {
  entry: ListEntry;
  onOpen: (id: string) => void;
}) {
  const open = () => onOpen(i.id);
  return (
    <li className="hover:bg-muted/50 relative flex items-center gap-3 px-4 py-3 transition-colors">
      <IntegrationIcon integration={i} />
      <div className="grid min-w-0 flex-1 gap-x-6 gap-y-0.5 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] md:items-center">
        {/* The name's button stretches over the whole row; the actions on the right sit above it. */}
        <button
          type="button"
          onClick={open}
          className="focus-visible:after:ring-ring/50 truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-inset"
        >
          {i.label}
        </button>
        <p className="text-muted-foreground truncate text-xs md:text-sm">
          {i.catalog ? (
            i.catalog.tagline
          ) : (
            <span className="font-mono text-xs">Custom · {host(i)}</span>
          )}
          {hit && (
            <span>
              {" · "}
              {hit.kind} <code className="text-foreground font-mono text-xs">{hit.name}</code>
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {isSetUp(i) ? (
          <Status integration={i} onOpen={open} />
        ) : (
          <Connect integration={i} onOpen={open} />
        )}
      </div>
      <CaretRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
    </li>
  );
}

function Status({ integration: i, onOpen }: { integration: Integration; onOpen: () => void }) {
  const h = health(i);
  switch (h) {
    case "connected":
      return (
        <HealthLabel health={h}>
          <span className="text-muted-foreground hidden font-normal sm:inline">
            {" · "}
            {i.tools.length} {i.tools.length === 1 ? "tool" : "tools"}
            {i.skills.length > 0 &&
              ` · ${i.skills.length} ${i.skills.length === 1 ? "skill" : "skills"}`}
          </span>
        </HealthLabel>
      );
    case "needs-auth":
      return (
        <>
          <HealthLabel health={h} />
          <SignInButton
            integration={i}
            size="sm"
            variant="outline"
            className="relative z-10"
            onRefused={(e) => {
              toast.error(e);
              onOpen();
            }}
          >
            Sign in
          </SignInButton>
        </>
      );
    case "failed":
      return (
        <HealthLabel health={h}>
          <span className="text-muted-foreground hidden font-normal sm:inline"> · View error</span>
        </HealthLabel>
      );
    case "paused":
    case "not-connected":
      return <HealthLabel health={h} />;
    default: {
      const _exhaustive: never = h;
      return _exhaustive;
    }
  }
}

/** A built-in not set up yet: how much work connecting is, and Connect. One-click services sign in straight from the row. */
function Connect({ integration: i, onOpen }: { integration: Integration; onOpen: () => void }) {
  return (
    <>
      <span className="text-muted-foreground hidden text-xs sm:inline">{effort(i.auth)}</span>
      {isOneClick(i.auth) ? (
        <SignInButton integration={i} size="sm" variant="outline" className="relative z-10">
          <PlusIcon data-icon="inline-start" />
          Connect
        </SignInButton>
      ) : (
        <Button size="sm" variant="outline" className="relative z-10" onClick={onOpen}>
          <PlusIcon data-icon="inline-start" />
          Connect
        </Button>
      )}
    </>
  );
}
