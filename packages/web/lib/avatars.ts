import {
  COLOR_NAMES,
  nameAt,
  SHAPE_NAMES,
  type BotAvatar,
  type Color,
  type Shape,
} from "@tomte/contract/avatars";
import type { CSSProperties } from "react";

/**
 * Solid bodies on a 100×100 canvas, each with where its eyes sit. `BotAvatar` paints a body with a 14-wide stroke in
 * its own fill and round joins, so every corner is rounded by 7 and the outline grows by 7: keep the path 7 inside the
 * canvas. Circles overlap freely; a union of filled subpaths is one silhouette. `tilt` turns the body (degrees,
 * clockwise) without turning its eyes.
 */
export const SHAPES: Record<
  Shape,
  { d: string; eyes: readonly [x: number, y: number]; tilt?: number }
> = {
  ball: { d: "M15 50a35 35 0 1 0 70 0a35 35 0 1 0-70 0Z", eyes: [60, 40] },
  block: {
    d: "M30 18H70A12 12 0 0 1 82 30V70A12 12 0 0 1 70 82H30A12 12 0 0 1 18 70V30A12 12 0 0 1 30 18Z",
    tilt: 8,
    eyes: [60, 44],
  },
  gem: { d: "M50 14L86 50L50 86L14 50Z", eyes: [56, 44] },
  hex: { d: "M30 18H70L88 50L70 82H30L12 50Z", eyes: [60, 40] },
  drop: { d: "M50 14C58 28 78 42 78 60A28 28 0 0 1 22 60C22 42 42 28 50 14Z", eyes: [57, 58] },
  pill: {
    d: "M38 24H62A26 26 0 0 1 62 76H38A26 26 0 0 1 38 24Z",
    tilt: -14,
    eyes: [60, 44],
  },
  cloud: {
    d: "M14 60a20 20 0 1 0 40 0a20 20 0 1 0-40 0ZM44 60a20 20 0 1 0 40 0a20 20 0 1 0-40 0ZM28 42a22 22 0 1 0 44 0a22 22 0 1 0-44 0ZM34 60H64V78H34Z",
    eyes: [57, 52],
  },
  flower: {
    d: "M34 30a16 16 0 1 0 32 0a16 16 0 1 0-32 0ZM54 50a16 16 0 1 0 32 0a16 16 0 1 0-32 0ZM34 70a16 16 0 1 0 32 0a16 16 0 1 0-32 0ZM14 50a16 16 0 1 0 32 0a16 16 0 1 0-32 0ZM28 50a22 22 0 1 0 44 0a22 22 0 1 0-44 0Z",
    eyes: [54, 46],
  },
  heart: {
    d: "M50 84C24 66 16 53 16 40C16 27 25 19 34 19C42 19 47 24 50 30C53 24 58 19 66 19C75 19 84 27 84 40C84 53 76 66 50 84Z",
    eyes: [57, 46],
  },
  cone: { d: "M50 14L84 82H16Z", eyes: [54, 62] },
  star: {
    d: "M50 16L61.8 37.8L86.1 42.3L69 60.2L72.3 84.7L50 74L27.7 84.7L31 60.2L13.9 42.3L38.2 37.8Z",
    eyes: [54, 54],
  },
  arch: { d: "M18 84V48A32 32 0 0 1 82 48V84Z", eyes: [58, 46] },
};

/** Body colors; `ink` follows the theme's text color, the rest read on both light and dark backgrounds. */
export const COLORS: Record<Color, string> = {
  ink: "currentColor",
  coral: "oklch(0.66 0.16 38)",
  amber: "oklch(0.76 0.15 75)",
  green: "oklch(0.66 0.15 150)",
  teal: "oklch(0.68 0.11 195)",
  blue: "oklch(0.62 0.16 255)",
  violet: "oklch(0.62 0.18 295)",
  pink: "oklch(0.68 0.18 350)",
};

/** What is drawn on a body of `color`: near-white on the colors, the page background on `ink`. */
export function onColor(color: Color): string {
  return color === "ink" ? "var(--background)" : "oklch(0.985 0 0)";
}

/** Inline style for a `.bot-theme` element: the color as a solid fill and the text color on it. */
export function botTheme(color: Color): CSSProperties {
  return {
    "--bot": color === "ink" ? "var(--foreground)" : COLORS[color],
    "--bot-foreground": onColor(color),
  } as CSSProperties;
}

export function randomAvatar(): BotAvatar {
  return {
    shape: nameAt(SHAPE_NAMES, Math.floor(Math.random() * SHAPE_NAMES.length)),
    color: nameAt(COLOR_NAMES, 1 + Math.floor(Math.random() * (COLOR_NAMES.length - 1))),
  };
}
