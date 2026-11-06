import {
  FACE_NAMES,
  nameAt,
  STROKE_NAMES,
  STROKES,
  type BotAvatar,
  type Stroke,
} from "@claudebot/contract/avatars";
import type { CSSProperties } from "react";

/** Inline style for a `.bot-theme` element: the stroke as a solid fill and the text color on it; `ink` fills with the theme's text color. */
export function botTheme(stroke: Stroke): CSSProperties {
  const ink = stroke === "ink";
  return {
    "--bot": ink ? "var(--foreground)" : STROKES[stroke],
    "--bot-foreground": ink ? "var(--background)" : "oklch(0.985 0 0)",
  } as CSSProperties;
}

export function randomAvatar(): BotAvatar {
  return {
    face: nameAt(FACE_NAMES, Math.floor(Math.random() * FACE_NAMES.length)),
    stroke: nameAt(STROKE_NAMES, 1 + Math.floor(Math.random() * (STROKE_NAMES.length - 1))),
  };
}
