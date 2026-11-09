import type { HostInfo } from "@claudebot/contract/api";
import type { BotStatus, BotSummary } from "@claudebot/contract/events";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  FolderIcon,
  KeyRoundIcon,
  LaptopIcon,
  MoonIcon,
  PlugIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { type ReactNode } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { confirmAction } from "@/components/confirm.tsx";
import { TitlebarStrip } from "@/components/titlebar.tsx";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import { deleteBot } from "@/host/api.ts";
import { shortTime } from "@/lib/format.ts";
import { withoutTransitions } from "@/lib/theme.ts";
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

/** A bot's sidebar row; right-clicking it (or a long press) opens its actions. */
function BotContextMenu({ bot, children }: { bot: BotSummary; children: ReactNode }) {
  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${bot.name}?`,
      description:
        "Its routines and credential grants are removed, its browser logins are signed out and its open handoffs fail. Memory and files are moved to the trash folder in the data root (bots/.trash).",
      action: "Delete",
      destructive: true,
    });
    if (ok) await deleteBot(bot.id);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<SidebarMenuItem />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem
          variant="destructive"
          disabled={bot.status === "working"}
          onClick={() => void remove()}
        >
          <Trash2Icon /> Delete bot
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AppSidebar({
  bots,
  info,
  integrationsNeedingAttention,
  onNewBot,
}: {
  bots: BotSummary[];
  info: HostInfo | undefined;
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
      <TitlebarStrip className="border-sidebar-border [:root[data-wco]_&]:border-b" />
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
                <BotContextMenu key={b.id} bot={b}>
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
                        {b.needsYou > 0 && (
                          <span
                            className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 tabular-nums dark:text-amber-400"
                            title={`${b.needsYou} ${b.needsYou === 1 ? "item needs" : "items need"} you`}
                            aria-label={`${b.needsYou} ${b.needsYou === 1 ? "item needs" : "items need"} you`}
                            data-needs-you={b.needsYou}
                          >
                            {b.needsYou}
                          </span>
                        )}
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
                </BotContextMenu>
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
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!matchRoute({ to: "/devices" })}
              render={<Link to="/devices" />}
              onClick={reveal}
            >
              <LaptopIcon />
              <span>Devices</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
            onClick={() => withoutTransitions(() => setTheme(dark ? "light" : "dark"))}
          />
        }
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipContent>{dark ? "Light theme" : "Dark theme"}</TooltipContent>
    </Tooltip>
  );
}
