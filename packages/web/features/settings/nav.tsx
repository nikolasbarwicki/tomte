import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { SECTIONS, SETTINGS_GROUPS } from "./sections.ts";

/** What the sidebar holds while Settings is open, in place of the bots: the way back, then the sections in their groups. `onNavigate` runs on every pick (it closes the sidebar's sheet on a phone). */
export function SettingsNav({ onNavigate }: { onNavigate: () => void }) {
  const { section } = useParams({ strict: false });
  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" />} onClick={onNavigate}>
              <ArrowLeftIcon />
              <span>Back to app</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <nav aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.sections.map((s) => {
                  const { label, icon: Icon } = SECTIONS[s];
                  return (
                    <SidebarMenuItem key={s}>
                      <SidebarMenuButton
                        isActive={s === section}
                        render={
                          <Link
                            to="/settings/$section"
                            params={{ section: s }}
                            aria-current={s === section ? "page" : undefined}
                          />
                        }
                        onClick={onNavigate}
                      >
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </nav>
    </SidebarContent>
  );
}
