import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";

/** The top bar of every view: the sidebar's button (phones only; on a wider window the sidebar is always there and has its edge), then the view's own title and actions. It is the desktop app's title bar: a drag region (see tailwind.css), indented past the native window controls while it starts at the window's left edge (`--titlebar-inset`, set by the shell). It is the sheet's top row, so it starts 8px below the window's top, and 40px tall it shares its centre line with the native controls (`TITLE_BAR_HEIGHT` in the desktop package is 8 + 40 + 8). */
export function AppBar({ children }: { children?: ReactNode }) {
  return (
    <header
      data-titlebar
      className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-[calc(--spacing(3)+var(--titlebar-inset,0px))]"
    >
      <SidebarTrigger className="text-muted-foreground" />
      {children}
    </header>
  );
}

/** A full-width settings-style screen: a title bar, an optional intro line, then scrollable content. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppBar>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {actions}
      </AppBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
          {description && <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
