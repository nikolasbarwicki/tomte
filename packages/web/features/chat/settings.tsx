import { BotModel, EffortLevel, type BotSummary } from "@claudebot/contract/events";
import { useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useChat } from "@/host/hooks.ts";

import { setChatMode, setEffort, setModel } from "./api.ts";
import { livePresence } from "./model.ts";

const MODEL_LABELS: Record<BotModel, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

/** The Settings tab: how the bot chats and what it runs on, saved with the bot. Switching mode starts a new conversation, so it asks first. */
export function ChatSettings({ bot }: { bot: BotSummary }) {
  const busy = livePresence(bot.chatMode, useChat()) !== "idle";
  const doubleLoop = bot.chatMode === "double_loop";
  const [switching, startSwitch] = useTransition();
  const [applying, startApply] = useTransition();

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
    <FieldGroup className="gap-6" data-testid="chat-settings">
      <Field orientation="horizontal" data-disabled={busy || switching}>
        <FieldContent>
          <FieldLabel htmlFor="double-loop">Double-loop chat</FieldLabel>
          <FieldDescription className="text-xs">
            {bot.name} replies at once, even while it works: research and hands-on work run as
            background tasks, which the Tasks tab follows, and the chat shows only messages.
            Switching starts a new conversation.
          </FieldDescription>
          {busy && (
            <FieldDescription className="text-xs">
              {doubleLoop
                ? "Available once no task runs and the bot is not replying."
                : "Available once the bot finishes its turn."}
            </FieldDescription>
          )}
        </FieldContent>
        <Switch
          id="double-loop"
          checked={doubleLoop}
          disabled={busy || switching}
          onCheckedChange={(next) => void toggle(next)}
        />
      </Field>
      <FieldSeparator />
      <FieldSet className="gap-4">
        <div className="grid gap-0.5">
          <FieldLegend variant="label" className="mb-0">
            {doubleLoop ? "Background tasks" : "Model"}
          </FieldLegend>
          <FieldDescription className="text-xs">
            {doubleLoop
              ? "What research and work tasks run on, from the next task. Replies come from Haiku, which answers in seconds."
              : `What ${bot.name} runs on, from its next reply.`}
          </FieldDescription>
        </div>
        <Choice
          label="Model"
          options={BotModel.options}
          labels={MODEL_LABELS}
          value={bot.model}
          disabled={applying}
          onChange={(model) => startApply(async () => void (await setModel(model)))}
        />
        <Choice
          label="Effort"
          options={EffortLevel.options}
          labels={EFFORT_LABELS}
          value={bot.effort}
          disabled={applying}
          onChange={(effort) => startApply(async () => void (await setEffort(effort)))}
        />
      </FieldSet>
    </FieldGroup>
  );
}

function Choice<T extends string>({
  label,
  options,
  labels,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Field>
      <FieldLabel className="text-muted-foreground text-xs">{label}</FieldLabel>
      <ToggleGroup
        size="sm"
        variant="outline"
        spacing={0}
        aria-label={label}
        disabled={disabled}
        value={[value]}
        onValueChange={(values: string[]) => {
          const next = options.find((o) => o === values[0]);
          if (next && next !== value) onChange(next);
        }}
      >
        {options.map((o) => (
          <ToggleGroupItem key={o} value={o} className="px-2.5 text-xs">
            {labels[o]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
