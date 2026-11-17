import { z } from "zod";

export const SHAPE_NAMES = [
  "ball",
  "block",
  "gem",
  "hex",
  "drop",
  "pill",
  "cloud",
  "flower",
  "heart",
  "cone",
  "star",
  "arch",
] as const;
export const COLOR_NAMES = [
  "ink",
  "coral",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export type Shape = (typeof SHAPE_NAMES)[number];
export type Color = (typeof COLOR_NAMES)[number];

export const BotAvatar = z.object({ shape: z.literal(SHAPE_NAMES), color: z.literal(COLOR_NAMES) });
export type BotAvatar = z.infer<typeof BotAvatar>;

/** The name at `i` wrapped into range; the name lists are non-empty constants, so a miss is a programming error. */
export function nameAt<T extends string>(names: readonly T[], i: number): T {
  const name = names[i % names.length];
  if (name === undefined) throw new RangeError("nameAt: empty name list");
  return name;
}

/** A stable avatar derived from the bot id, for bots created before avatars existed. */
export function defaultAvatar(id: string): BotAvatar {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    shape: nameAt(SHAPE_NAMES, h),
    color: nameAt(COLOR_NAMES, h >>> 8),
  };
}
