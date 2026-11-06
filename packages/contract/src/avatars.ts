import { z } from "zod";

export const FACE_NAMES = [
  "tuft",
  "ears",
  "antenna",
  "glasses",
  "bun",
  "posh",
  "beard",
  "cyclops",
  "mustache",
  "beanie",
  "crown",
  "sleepy",
  "horns",
  "bolts",
  "eyepatch",
] as const;
export const STROKE_NAMES = [
  "ink",
  "coral",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export type Face = (typeof FACE_NAMES)[number];
export type Stroke = (typeof STROKE_NAMES)[number];

export const BotAvatar = z.object({ face: z.literal(FACE_NAMES), stroke: z.literal(STROKE_NAMES) });
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
    face: nameAt(FACE_NAMES, h),
    stroke: nameAt(STROKE_NAMES, h >>> 8),
  };
}
