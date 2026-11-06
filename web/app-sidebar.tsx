import { useState } from "react";
import { useTheme } from "next-themes";
import { BellIcon, BotIcon, FolderIcon, KeyRoundIcon, MoonIcon, PlugIcon, PlusIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BotStatus, BotSummary, HostInfo, Notice } from "./events.ts";
import { shortTime } from "./format.ts";

export type View = "chat" | "integrations" | "credentials";

const STATUS_LABEL: Record<BotStatus, string> = { idle: "Idle", working: "Working", unseen: "New reply" };

export function StatusDot({ status, className }: { status: BotStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "idle" && "border border-muted-foreground/40",
        status === "working" && "animate-pulse bg-primary",
        status === "unseen" && "bg-blue-500",
        className,
      )}
    />
  );
}

export function AppSidebar({
  bots,
  botId,
  view,
  info,
  notices,
  integrationsNeedingAttention,
  onView,
  onOpenBot,
  onNewBot,
}: {
  bots: BotSummary[];
  botId: string | undefined;
  view: View;
  info: HostInfo | undefined;
  notices: Notice[];
  integrationsNeedingAttention: number;
  onView: (v: View) => void;
  onOpenBot: (id: string) => void;
  onNewBot: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  // On phones the sidebar is a sheet; picking a destination should reveal it.
  const go = (fn: () => void) => () => {
    fn();
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BotIcon className="size-4" />
          </div>
          <div className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-semibold">claudebot</span>
            <span className="truncate text-xs text-muted-foreground" title={info?.cli}>
              {info ? `Claude via ${info.auth}` : "Connecting…"}
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Bots</SidebarGroupLabel>
          <SidebarGroupAction title="New bot" onClick={go(onNewBot)}>
            <PlusIcon />
            <span className="sr-only">New bot</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {bots.map((b) => (
                <SidebarMenuItem key={b.id}>
                  <SidebarMenuButton
                    isActive={view === "chat" && b.id === botId}
                    onClick={go(() => onOpenBot(b.id))}
                    title={b.purpose || undefined}
                    className="h-auto items-start gap-2.5 py-2"
                  >
                    <StatusDot status={b.status} className="mt-1.5" />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className={cn("truncate", b.status === "unseen" && "font-semibold")}>{b.name}</span>
                        {b.last && (
                          <time
                            className={cn("ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums", b.status === "unseen" && "font-semibold text-foreground")}
                            title={new Date(b.last.at).toLocaleString()}
                          >
                            {shortTime(b.last.at)}
                          </time>
                        )}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {b.status === "working" ? "Working…" : b.last ? `${b.last.from === "user" ? "You: " : ""}${b.last.text}` : b.purpose || "No messages yet"}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {bots.length === 0 && (
              <Button variant="outline" size="sm" className="mt-1 w-full" onClick={go(onNewBot)}>
                <PlusIcon /> New bot
              </Button>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={view === "integrations"} onClick={go(() => onView("integrations"))}>
              <PlugIcon />
              <span>Integrations</span>
            </SidebarMenuButton>
            {integrationsNeedingAttention > 0 && (
              <SidebarMenuBadge className="bg-destructive/10 text-destructive" title="Integrations that need sign-in or failed">
                {integrationsNeedingAttention}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={view === "credentials"} onClick={go(() => onView("credentials"))}>
              <KeyRoundIcon />
              <span>Credentials</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <Updates notices={notices} />
        </SidebarMenu>
        <div className="flex items-center gap-1.5 border-t px-2 pt-2 text-xs text-muted-foreground">
          <FolderIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={info?.cwd}>
            {info?.cwd ?? "…"}
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function Updates({ notices }: { notices: Notice[] }) {
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const unread = notices.filter((n) => n.at > seenAt).length;
  return (
    <SidebarMenuItem>
      <Popover onOpenChange={(open) => open && setSeenAt(Date.now())}>
        <PopoverTrigger render={<SidebarMenuButton />}>
          <BellIcon />
          <span>Updates</span>
        </PopoverTrigger>
        <PopoverContent side="right" align="end" className="w-80 gap-0 p-0">
          <PopoverHeader className="border-b p-3">
            <PopoverTitle>Updates</PopoverTitle>
            <PopoverDescription>Notifications from herdr and omp hooks.</PopoverDescription>
          </PopoverHeader>
          {notices.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {notices.map((n) => (
                <li key={`${n.at}-${n.title}`} className="grid gap-0.5 p-3 text-sm">
                  <span className="font-medium">{n.title}</span>
                  {n.body && <span className="line-clamp-3 text-muted-foreground">{n.body}</span>}
                  <span className="text-xs text-muted-foreground">
                    {n.source} · {shortTime(n.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {unread > 0 && <SidebarMenuBadge className="bg-primary text-primary-foreground">{unread}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={dark ? "Light theme" : "Dark theme"} onClick={() => setTheme(dark ? "light" : "dark")} />}>
        {dark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipContent>{dark ? "Light theme" : "Dark theme"}</TooltipContent>
    </Tooltip>
  );
}
