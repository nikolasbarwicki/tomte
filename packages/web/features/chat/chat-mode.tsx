import type { BotSummary } from "@claudebot/contract/events";
import { SlidersHorizontalIcon } from "lucide-react";
import { useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

import { setChatMode } from "./api.ts";

/** The bot's chat settings in the app bar. Switching mode starts a new conversation, so it asks first. */
export function ChatModeMenu({ bot, busy }: { bot: BotSummary; busy: boolean }) {
  const [switching, startSwitch] = useTransition();
  const doubleLoop = bot.chatMode === "double_loop";
  const toggle = async (next: boolean) => {
    const ok = await confirmAction({
      title: `${next ? "Switch to" : "Leave"} double-loop chat for ${bot.name}?`,
      description:
        "A new conversation starts and the bot forgets this one. Memory, files and routines are kept.",
      action: "Switch and start new",
    });
    if (ok)
      startSwitch(async () => {
        await setChatMode(bot.id, next ? "double_loop" : "standard");
      });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Chat settings"
            disabled={busy || switching}
          />
        }
      >
        {switching ? <Spinner /> : <SlidersHorizontalIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Chat</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={doubleLoop} onCheckedChange={(c) => void toggle(c)}>
            Double-loop chat
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
