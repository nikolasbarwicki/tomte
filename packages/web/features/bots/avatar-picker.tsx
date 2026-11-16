import { FACE_NAMES, STROKE_NAMES, type BotAvatar as Avatar } from "@claudebot/contract/avatars";
import { useId } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { STROKES } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

const choice =
  "relative grid cursor-pointer place-items-center rounded-lg ring-1 ring-transparent transition-colors hover:bg-muted has-checked:bg-muted has-checked:ring-foreground/40 has-focus-visible:ring-2 has-focus-visible:ring-ring";

/** The face grid and stroke colours for choosing a bot's avatar; used where a bot is created and where its profile is edited. */
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
        <div className="grid grid-cols-5 gap-1">
          {FACE_NAMES.map((face) => (
            <label key={face} className={cn(choice, "h-12")} title={face}>
              <input
                type="radio"
                name={`${group}-face`}
                value={face}
                checked={avatar.face === face}
                onChange={() => onChange({ ...avatar, face })}
                className="sr-only"
              />
              <BotAvatar avatar={{ face, stroke: avatar.stroke }} className="size-10" />
              <span className="sr-only">{face}</span>
            </label>
          ))}
        </div>
      </FieldSet>
      <FieldSet className="gap-2">
        <FieldLegend variant="label">Stroke color</FieldLegend>
        <div className="flex flex-wrap gap-1">
          {STROKE_NAMES.map((stroke) => (
            <label key={stroke} className={cn(choice, "size-8 rounded-full")} title={stroke}>
              <input
                type="radio"
                name={`${group}-stroke`}
                value={stroke}
                checked={avatar.stroke === stroke}
                onChange={() => onChange({ ...avatar, stroke })}
                className="sr-only"
              />
              <span className="size-5 rounded-full" style={{ background: STROKES[stroke] }} />
              <span className="sr-only">{stroke}</span>
            </label>
          ))}
        </div>
      </FieldSet>
    </>
  );
}
