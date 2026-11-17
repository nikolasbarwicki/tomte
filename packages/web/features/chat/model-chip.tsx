import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { ArrowsSplitIcon, CaretDownIcon } from "@phosphor-icons/react";
import { BotModel, EffortLevel, type BotSummary, type ChatMode } from "@tomte/contract/events";
import { useTransition, type ReactNode } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useChat, useOpenBotId } from "@/host/hooks.ts";
import { cn } from "@/lib/utils";

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

const MODES: { id: ChatMode; title: string; body: string }[] = [
  {
    id: "standard",
    title: "One thread",
    body: "Works through one thing at a time. You wait while it works.",
  },
  {
    id: "double_loop",
    title: "Double loop",
    body: "Replies at once and runs research and work as parallel background tasks.",
  },
];

/** The chip in the message box that says what the bot runs on ("Sonnet · High", with a split arrow for a double-loop bot) and opens how it chats, what it runs on and how hard it thinks. */
export function ModelChip({ bot }: { bot: BotSummary }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <InputGroupButton
            aria-label="Model and chat"
            className="text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground gap-1.5 rounded-lg px-2 tabular-nums"
          />
        }
      >
        {bot.chatMode === "double_loop" && <ArrowsSplitIcon className="size-3.5 opacity-70" />}
        <span>
          {MODEL_LABELS[bot.model]} · {EFFORT_LABELS[bot.effort]}
        </span>
        <CaretDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="grid w-80 gap-5">
        <ModelSettings bot={bot} />
      </PopoverContent>
    </Popover>
  );
}

/** How the bot chats and what it runs on, saved with the bot. Switching mode starts a new conversation, so it asks first. */
function ModelSettings({ bot }: { bot: BotSummary }) {
  const busy = livePresence(bot.chatMode, useChat()) !== "idle";
  const doubleLoop = bot.chatMode === "double_loop";
  const [switching, startSwitch] = useTransition();
  const [applying, startApply] = useTransition();
  // Model and effort apply to the chat the host streams, which is another bot's for a moment after switching.
  const streamed = useOpenBotId() === bot.id;

  const switchTo = async (mode: ChatMode) => {
    const next = mode === "double_loop";
    const ok = await confirmAction({
      title: `${next ? "Switch to" : "Leave"} double-loop chat for ${bot.name}?`,
      description:
        "A new conversation starts and the bot forgets this one. Memory, files and routines are kept.",
      action: "Switch and start new",
    });
    if (ok)
      startSwitch(async () => {
        await setChatMode(bot.id, mode);
      });
  };

  return (
    <div className="grid gap-5" data-testid="model-settings">
      <Section title="Chat" hint="Switching starts a new conversation.">
        <RadioGroup
          aria-label="Chat mode"
          value={bot.chatMode}
          disabled={busy || switching}
          onValueChange={(mode) => {
            const next = MODES.find((m) => m.id === mode);
            if (next && next.id !== bot.chatMode) void switchTo(next.id);
          }}
          className="grid grid-cols-2 gap-2"
        >
          {MODES.map((m) => (
            <Radio.Root
              key={m.id}
              value={m.id}
              className={cn(
                "grid content-start gap-1 rounded-xl p-3 text-left ring-1 ring-inset outline-none transition-colors",
                "focus-visible:ring-ring/50 focus-visible:ring-3 data-disabled:opacity-60",
                "data-checked:bg-accent data-checked:ring-foreground/30 not-data-checked:ring-border not-data-checked:not-data-disabled:hover:bg-muted/60",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="ring-foreground/30 in-data-checked:bg-primary in-data-checked:ring-primary grid size-3.5 place-items-center rounded-full ring-1 ring-inset">
                  <Radio.Indicator className="bg-primary-foreground size-1.5 rounded-full" />
                </span>
                {m.title}
              </span>
              <span className="text-muted-foreground text-xs text-pretty">{m.body}</span>
            </Radio.Root>
          ))}
        </RadioGroup>
        {busy && (
          <p className="text-muted-foreground text-xs">
            {doubleLoop
              ? "Switching is available once no task runs and the bot is not replying."
              : "Switching is available once the bot finishes its turn."}
          </p>
        )}
      </Section>
      <Section title={doubleLoop ? "Background tasks run on" : "Model"}>
        <Choice
          label="Model"
          options={BotModel.options}
          labels={MODEL_LABELS}
          value={bot.model}
          disabled={applying || !streamed}
          onChange={(model) => startApply(async () => void (await setModel(model)))}
        />
        <Choice
          label="Reasoning effort"
          options={EffortLevel.options}
          labels={EFFORT_LABELS}
          value={bot.effort}
          disabled={applying || !streamed}
          onChange={(effort) => startApply(async () => void (await setEffort(effort)))}
        />
        <p className="text-muted-foreground text-xs text-pretty">
          {doubleLoop
            ? "Replies come from Haiku, which answers in seconds. Applies from the next task."
            : "Applies from the next reply."}
        </p>
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <FieldDescription className="text-xs">{hint}</FieldDescription>}
      </div>
      {children}
    </section>
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
        className="w-full"
        onValueChange={(values: string[]) => {
          const next = options.find((o) => o === values[0]);
          if (next && next !== value) onChange(next);
        }}
      >
        {options.map((o) => (
          <ToggleGroupItem key={o} value={o} className="flex-1 px-1.5 text-xs">
            {labels[o]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
