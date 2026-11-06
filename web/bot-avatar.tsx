import { cn } from "@/lib/utils";
import { FACES, STROKES, type BotAvatar as Avatar } from "../src/contract/avatars.ts";

/** A bot's one-line face. While `working`, the line keeps drawing and erasing itself. */
export function BotAvatar({ avatar, working = false, className }: { avatar: Avatar; working?: boolean; className?: string }) {
  return (
    <svg viewBox="16 16 128 128" aria-hidden className={cn("size-8 shrink-0", working && "bot-avatar-working", className)}>
      <path
        d={FACES[avatar.face]}
        pathLength={1}
        fill="none"
        stroke={STROKES[avatar.stroke]}
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
