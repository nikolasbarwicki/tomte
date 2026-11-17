import {
  PlugIcon,
  PlusIcon,
  GearIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import type { BotStatus, BotSummary } from "@tomte/contract/events";
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
import { SettingsNav } from "@/features/settings/index.ts";
import { deleteBot } from "@/host/api.ts";
import { usePublicHostInfo } from "@/host/hooks.ts";
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

/** A bot's sidebar row; right-clicking it (or a long press) opens its actions. */
function BotContextMenu({ bot, children }: { bot: BotSummary; children: ReactNode }) {
  const navigate = useNavigate();
  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${bot.name}?`,
      description:
        "Its routines are removed, its browser logins are signed out and its open handoffs fail. Memory and files are moved to the trash folder in the data root (bots/.trash).",
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
          onClick={() =>
            void navigate({
              to: "/bots/$botId",
              params: { botId: bot.id },
              search: { panel: "settings", section: "profile" },
            })
          }
        >
          <SlidersHorizontalIcon /> Bot settings
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={bot.status === "working"}
          onClick={() => void remove()}
        >
          <TrashIcon /> Delete bot
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AppSidebar({
  bots,
  integrationsNeedingAttention,
  onNewBot,
}: {
  bots: BotSummary[];
  integrationsNeedingAttention: number;
  onNewBot: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const matchRoute = useMatchRoute();
  // A remote host whose Claude CLI is signed out cannot run any bot; Settings points at Models, where it says how to sign in.
  const claudeSignedOut = usePublicHostInfo()?.claude === "signed-out";
  // On phones the sidebar is a sheet; picking a destination should reveal it.
  const reveal = () => {
    if (isMobile) setOpenMobile(false);
  };
  const newBot = () => {
    onNewBot();
    reveal();
  };
  // The sidebar sits 8px inside the window (`variant="inset"`), so its strip under the native window controls ends where the sheet's 40px top bar does.
  const strip = <TitlebarStrip className="h-[max(0px,calc(env(titlebar-area-height,0px)-16px))]" />;
  if (matchRoute({ to: "/settings", fuzzy: true }))
    return (
      <Sidebar variant="inset">
        {strip}
        <SettingsNav onNavigate={reveal} />
        <SidebarRail />
      </Sidebar>
    );
  return (
    <Sidebar variant="inset">
      {strip}
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
                    className="h-auto items-center gap-2.5 py-2"
                  >
                    <StatusAvatar bot={b} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className={cn("truncate", b.status === "unseen" && "font-semibold")}>
                          {b.name}
                        </span>
                        {b.chiefOfStaff && (
                          <span
                            className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 text-[11px] font-medium"
                            data-chief-of-staff
                          >
                            Chief of Staff
                          </span>
                        )}
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
              isActive={!!matchRoute({ to: "/settings", fuzzy: true })}
              render={
                <Link
                  to="/settings/$section"
                  params={{ section: claudeSignedOut ? "models" : "general" }}
                />
              }
              onClick={reveal}
            >
              <GearIcon />
              <span>Settings</span>
            </SidebarMenuButton>
            {claudeSignedOut && (
              <SidebarMenuBadge
                className="bg-destructive/10 text-destructive"
                title="Claude is not signed in"
                aria-label="Claude is not signed in"
              >
                !
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
