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
import { useHostStatus } from "@/host/hooks.ts";
import { shortTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<BotStatus, string> = {
  idle: "Idle",
  working: "Working",
  unseen: "New reply",
};

const needsYouLabel = (n: number) => `${n} ${n === 1 ? "item needs" : "items need"} you`;

/**
 * The bot's face; it animates while the bot works and carries a dot for an unseen reply. On the rail, where there is no
 * row to hold it, the needs-you count sits on its corner instead of the dot.
 */
function StatusAvatar({
  bot,
  small = false,
  rail = false,
}: {
  bot: BotSummary;
  small?: boolean;
  rail?: boolean;
}) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[bot.status]}
      title={rail ? undefined : STATUS_LABEL[bot.status]}
      className="relative shrink-0"
    >
      <BotAvatar
        avatar={bot.avatar}
        working={bot.status === "working"}
        className={small ? "size-6!" : "size-8!"}
      />
      {rail && bot.needsYou > 0 ? (
        <span
          className="ring-sidebar absolute -top-1 -right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber-400 px-1 text-[10px] leading-none font-semibold text-amber-950 tabular-nums ring-2"
          aria-label={needsYouLabel(bot.needsYou)}
          data-needs-you={bot.needsYou}
        >
          {bot.needsYou}
        </span>
      ) : (
        bot.status === "unseen" && (
          <span className="ring-sidebar absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-500 ring-2" />
        )
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
              search: { panel: "profile" },
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
  const { isMobile, setOpenMobile, stop } = useSidebar();
  // The phone's sheet always shows whole rows.
  const shown = isMobile ? "full" : stop;
  const rail = shown === "rail";
  const matchRoute = useMatchRoute();
  // A host whose Claude CLI is signed out cannot run any bot; Settings points at Models, where it says how to sign in.
  const claudeSignedOut = useHostStatus()?.claude.state === "signed-out";
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
  // On the rail a destination is its icon in a 44px target, named by a tooltip.
  const railButton = "size-11 justify-center p-0 [&_svg]:size-5";
  if (matchRoute({ to: "/settings", fuzzy: true }))
    return (
      <Sidebar variant="inset" minStop="names">
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
          {!rail && (
            <>
              <SidebarGroupLabel>Bots</SidebarGroupLabel>
              <SidebarGroupAction title="New bot" onClick={newBot}>
                <PlusIcon />
                <span className="sr-only">New bot</span>
              </SidebarGroupAction>
            </>
          )}
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {bots.map((b) => (
                <BotContextMenu key={b.id} bot={b}>
                  <SidebarMenuButton
                    isActive={!!matchRoute({ to: "/bots/$botId", params: { botId: b.id } })}
                    render={<Link to="/bots/$botId" params={{ botId: b.id }} />}
                    onClick={reveal}
                    title={rail ? undefined : b.purpose || undefined}
                    aria-label={rail ? b.name : undefined}
                    tooltip={{
                      className: "grid gap-0.5 py-2",
                      children: (
                        <>
                          <span className="font-medium">
                            {b.name}
                            {b.chiefOfStaff && " · Chief of Staff"}
                          </span>
                          <span className="opacity-70">
                            {b.status === "working"
                              ? "Working…"
                              : b.needsYou > 0
                                ? needsYouLabel(b.needsYou)
                                : (b.last?.text ?? (b.purpose || "No messages yet"))}
                          </span>
                        </>
                      ),
                    }}
                    className={cn(
                      "data-active:font-normal",
                      rail && "size-11 justify-center p-0",
                      shown === "names" && "h-9 gap-2.5",
                      shown === "full" && "h-auto items-center gap-2.5 py-2",
                    )}
                  >
                    {rail ? (
                      <StatusAvatar bot={b} rail />
                    ) : shown === "names" ? (
                      <>
                        <StatusAvatar bot={b} small />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate",
                            b.status === "unseen" && "font-semibold",
                          )}
                        >
                          {b.name}
                        </span>
                        {b.needsYou > 0 && <NeedsYouCount n={b.needsYou} />}
                      </>
                    ) : (
                      <>
                        <StatusAvatar bot={b} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span
                                className={cn(
                                  "max-w-full shrink-0 truncate",
                                  b.status === "unseen" && "font-semibold",
                                )}
                              >
                                {b.name}
                              </span>
                              {b.chiefOfStaff && (
                                <span
                                  className="bg-muted text-muted-foreground min-w-0 truncate rounded-full px-1.5 text-[11px] font-medium"
                                  data-chief-of-staff
                                >
                                  Chief of Staff
                                </span>
                              )}
                            </span>
                            {b.needsYou > 0 && <NeedsYouCount n={b.needsYou} />}
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
                      </>
                    )}
                  </SidebarMenuButton>
                </BotContextMenu>
              ))}
              {rail && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="New bot"
                    aria-label="New bot"
                    onClick={newBot}
                    className={cn(railButton, "text-muted-foreground hover:text-foreground")}
                  >
                    <span className="border-muted-foreground/40 grid size-8 place-items-center rounded-full border border-dashed">
                      <PlusIcon className="size-4!" />
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
            {bots.length === 0 && !rail && (
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
              tooltip={
                integrationsNeedingAttention > 0
                  ? `Integrations · ${integrationsNeedingAttention} need attention`
                  : "Integrations"
              }
              className={cn(rail && railButton)}
            >
              <PlugIcon />
              <span className={cn(rail && "sr-only")}>Integrations</span>
            </SidebarMenuButton>
            {integrationsNeedingAttention > 0 &&
              (rail ? (
                <RailDot title="Integrations that need sign-in or failed" />
              ) : (
                <SidebarMenuBadge
                  className="bg-destructive/10 text-destructive"
                  title="Integrations that need sign-in or failed"
                >
                  {integrationsNeedingAttention}
                </SidebarMenuBadge>
              ))}
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
              tooltip={claudeSignedOut ? "Settings · Claude is not signed in" : "Settings"}
              className={cn(rail && railButton)}
            >
              <GearIcon />
              <span className={cn(rail && "sr-only")}>Settings</span>
            </SidebarMenuButton>
            {claudeSignedOut &&
              (rail ? (
                <RailDot title="Claude is not signed in" />
              ) : (
                <SidebarMenuBadge
                  className="bg-destructive/10 text-destructive"
                  title="Claude is not signed in"
                  aria-label="Claude is not signed in"
                >
                  !
                </SidebarMenuBadge>
              ))}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NeedsYouCount({ n }: { n: number }) {
  return (
    <span
      className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 tabular-nums dark:text-amber-400"
      title={needsYouLabel(n)}
      aria-label={needsYouLabel(n)}
      data-needs-you={n}
    >
      {n}
    </span>
  );
}

/** A destination's alert on the rail, where its count has no room: a dot on the icon's corner. */
function RailDot({ title }: { title: string }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className="bg-destructive ring-sidebar pointer-events-none absolute top-2 right-2 size-2 rounded-full ring-2"
    />
  );
}
