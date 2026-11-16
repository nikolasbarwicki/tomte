import { z } from "zod";

import { parseSchedule } from "./schedule.ts";

/** HTTP-boundary schema for a routine's editable fields. */
export const RoutineInput = z.object({
  name: z.string().trim().min(1, "name required"),
  instruction: z.string().trim().min(1, "instruction required"),
  schedule: z.unknown().transform((v, ctx) => {
    try {
      return parseSchedule(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  }),
  active: z.boolean().optional(),
  catchUp: z.boolean().optional(),
  notifyResult: z.boolean().optional(),
});
export type RoutineInput = z.output<typeof RoutineInput>;

/** HTTP-boundary schema for a routine edit: any subset of the editable fields, each exactly as `RoutineInput` has it. */
export const RoutinePatch = z.object({
  name: RoutineInput.shape.name.exactOptional(),
  instruction: RoutineInput.shape.instruction.exactOptional(),
  schedule: RoutineInput.shape.schedule.exactOptional(),
  active: z.boolean().exactOptional(),
  catchUp: z.boolean().exactOptional(),
  notifyResult: z.boolean().exactOptional(),
});
export type RoutinePatch = z.output<typeof RoutinePatch>;
