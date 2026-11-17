import { COLOR_NAMES, SHAPE_NAMES, type BotAvatar as Avatar } from "@tomte/contract/avatars";
import { useId } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { COLORS } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

const choice =
  "relative grid cursor-pointer place-items-center rounded-lg ring-1 ring-transparent transition-colors hover:bg-muted has-checked:bg-muted has-checked:ring-foreground/40 has-focus-visible:ring-2 has-focus-visible:ring-ring";

/** The shape grid and colours for choosing a bot's avatar; used where a bot is created and where its profile is edited. */
export function AvatarPicker({
  avatar,
  onChange,
}: {
  avatar: Avatar;
  onChange: (avatar: Avatar) => void;
}) {
  const group = useId();
  return (
    <>
      <FieldSet className="gap-2">
        <FieldLegend variant="label">Avatar</FieldLegend>
        <div className="grid grid-cols-6 gap-1">
          {SHAPE_NAMES.map((shape) => (
            <label key={shape} className={cn(choice, "h-12")} title={shape}>
              <input
                type="radio"
                name={`${group}-shape`}
                value={shape}
                checked={avatar.shape === shape}
                onChange={() => onChange({ ...avatar, shape })}
                className="sr-only"
              />
              <BotAvatar avatar={{ shape, color: avatar.color }} className="size-9" />
              <span className="sr-only">{shape}</span>
            </label>
          ))}
        </div>
      </FieldSet>
      <FieldSet className="gap-2">
        <FieldLegend variant="label">Color</FieldLegend>
        <div className="flex flex-wrap gap-1">
          {COLOR_NAMES.map((color) => (
            <label key={color} className={cn(choice, "size-8 rounded-full")} title={color}>
              <input
                type="radio"
                name={`${group}-color`}
                value={color}
                checked={avatar.color === color}
                onChange={() => onChange({ ...avatar, color })}
                className="sr-only"
              />
              <span className="size-5 rounded-full" style={{ background: COLORS[color] }} />
              <span className="sr-only">{color}</span>
            </label>
          ))}
        </div>
      </FieldSet>
    </>
  );
}
