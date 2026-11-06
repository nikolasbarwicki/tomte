import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/** The top bar of every view: the sidebar toggle, then the view's own title and actions. */
export function AppBar({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="my-auto mr-1 h-4 self-auto!" />
      {children}
    </header>
  );
}

/** A full-width settings-style screen: a title bar, an optional intro line, then scrollable content. */
export function Page({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppBar>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {actions}
      </AppBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
          {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
