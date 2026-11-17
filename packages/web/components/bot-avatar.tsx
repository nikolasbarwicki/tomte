import { type BotAvatar as Avatar } from "@tomte/contract/avatars";

import { COLORS, onColor, SHAPES } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

/** A bot's solid body with two eyes. While `working`, the body breathes and the eyes look around and blink. */
export function BotAvatar({
  avatar,
  working = false,
  className,
}: {
  avatar: Avatar;
  working?: boolean;
  className?: string;
}) {
  const { d, eyes, tilt } = SHAPES[avatar.shape];
  const [x, y] = eyes;
  const fill = COLORS[avatar.color];
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={cn("size-8 shrink-0", working && "bot-avatar-working", className)}
    >
      <g className="bot-avatar-body">
        <path
          d={d}
          transform={tilt ? `rotate(${tilt} 50 50)` : undefined}
          fill={fill}
          stroke={fill}
          strokeWidth={14}
          strokeLinejoin="round"
        />
        <g className="bot-avatar-eyes">
          <path
            d={`M${x - 11} ${y - 8}l5 16M${x + 5} ${y - 8}l5 16`}
            stroke={onColor(avatar.color)}
            strokeWidth={10}
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  );
}
