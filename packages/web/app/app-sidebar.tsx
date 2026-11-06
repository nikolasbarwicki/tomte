import type { HostInfo } from "@claudebot/contract/api";
import type { BotStatus, BotSummary, Notice } from "@claudebot/contract/events";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  BellIcon,
  FolderIcon,
  KeyRoundIcon,
  MoonIcon,
  PlugIcon,
  PlusIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<BotStatus, string> = {
  idle: "Idle",
  working: "Working",
  unseen: "New reply",
};

/** The bot's face; it animates while the bot works and carries a dot for an unseen reply. */
function StatusAvatar({ bot, className }: { bot: BotSummary; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[bot.status]}
      title={STATUS_LABEL[bot.status]}
      className={cn("relative shrink-0", className)}
    >
      <BotAvatar avatar={bot.avatar} working={bot.status === "working"} className="size-8!" />
      {bot.status === "unseen" && (
        <span className="ring-sidebar absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-500 ring-2" />
      )}
    </span>
  );
}

export function AppSidebar({
  bots,
  info,
  notices,
  integrationsNeedingAttention,
  onNewBot,
}: {
  bots: BotSummary[];
  info: HostInfo | undefined;
  notices: Notice[];
  integrationsNeedingAttention: number;
  onNewBot: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const matchRoute = useMatchRoute();
  // On phones the sidebar is a sheet; picking a destination should reveal it.
  const reveal = () => {
    if (isMobile) setOpenMobile(false);
  };
  const newBot = () => {
    onNewBot();
    reveal();
  };
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Bots</SidebarGroupLabel>
          <SidebarGroupAction title="New bot" onClick={newBot}>
            <PlusIcon />
            <span className="sr-only">New bot</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {bots.map((b) => (
                <SidebarMenuItem key={b.id}>
                  <SidebarMenuButton
                    isActive={!!matchRoute({ to: "/bots/$botId", params: { botId: b.id } })}
                    render={<Link to="/bots/$botId" params={{ botId: b.id }} />}
                    onClick={reveal}
                    title={b.purpose || undefined}
                    className="h-auto items-start gap-2.5 py-2"
                  >
                    <StatusAvatar bot={b} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className={cn("truncate", b.status === "unseen" && "font-semibold")}>
                          {b.name}
                        </span>
                        {b.last && (
                          <time
                            className={cn(
                              "ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums",
                              b.status === "unseen" && "font-semibold text-foreground",
                            )}
                            title={new Date(b.last.at).toLocaleString()}
                          >
                            {shortTime(b.last.at)}
                          </time>
                        )}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {b.status === "working"
                          ? "Working…"
                          : b.last
                            ? `${b.last.from === "user" ? "You: " : ""}${b.last.text}`
                            : b.purpose || "No messages yet"}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {bots.length === 0 && (
              <Button variant="outline" size="sm" className="mt-1 w-full" onClick={newBot}>
                <PlusIcon /> New bot
              </Button>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!matchRoute({ to: "/integrations", fuzzy: true })}
              render={<Link to="/integrations" />}
              onClick={reveal}
            >
              <PlugIcon />
              <span>Integrations</span>
            </SidebarMenuButton>
            {integrationsNeedingAttention > 0 && (
              <SidebarMenuBadge
                className="bg-destructive/10 text-destructive"
                title="Integrations that need sign-in or failed"
              >
                {integrationsNeedingAttention}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!matchRoute({ to: "/credentials" })}
              render={<Link to="/credentials" />}
              onClick={reveal}
            >
              <KeyRoundIcon />
              <span>Credentials</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <Updates notices={notices} />
        </SidebarMenu>
        <div className="text-muted-foreground flex items-center gap-1.5 border-t px-2 pt-2 text-xs">
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
            <p className="text-muted-foreground p-3 text-sm">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {notices.map((n) => (
                <li key={`${n.at}-${n.title}`} className="grid gap-0.5 p-3 text-sm">
                  <span className="font-medium">{n.title}</span>
                  {n.body && <span className="text-muted-foreground line-clamp-3">{n.body}</span>}
                  <span className="text-muted-foreground text-xs">
                    {n.source} · {shortTime(n.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {unread > 0 && (
        <SidebarMenuBadge className="bg-primary text-primary-foreground">{unread}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={dark ? "Light theme" : "Dark theme"}
            onClick={() => setTheme(dark ? "light" : "dark")}
          />
        }
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipContent>{dark ? "Light theme" : "Dark theme"}</TooltipContent>
    </Tooltip>
  );
}
