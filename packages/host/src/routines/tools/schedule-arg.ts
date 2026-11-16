import { z } from "zod";

/** A schedule as a bot writes it. `at` is an ISO 8601 instant with an offset or Z. */
export const ScheduleArg = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expr: z.string().describe('Five-field cron, e.g. "0 8 * * 1-5" for weekdays at 08:00'),
    tz: z.string().describe("IANA time zone, e.g. Europe/Warsaw"),
  }),
  z.object({
    kind: z.literal("once"),
    at: z.iso
      .datetime({ offset: true })
      .describe('ISO 8601 instant with an offset or Z, e.g. "2026-12-01T08:00:00+01:00"'),
  }),
]);
export type ScheduleArg = z.infer<typeof ScheduleArg>;

/** The routine fields as a bot passes them to a tool: snake_case, `schedule` as `ScheduleArg`. */
export type RoutineArgs = {
  name?: string | undefined;
  instruction?: string | undefined;
  schedule?: ScheduleArg | undefined;
  catch_up?: boolean | undefined;
  active?: boolean | undefined;
};

/**
 * The fields a bot passed, as the route schemas (`RoutineInput`, `RoutinePatch`) take them: `catch_up` is `catchUp`, `at` is epoch
 * milliseconds. A field the bot left out stays out, so a patch keeps what it did not name. The values are not judged here:
 * `parseSchedule` and the route schema stay the one judge.
 */
export function routineFields(args: RoutineArgs): Record<string, unknown> {
  const { name, instruction, schedule, catch_up, active } = args;
  return {
    ...(name !== undefined && { name }),
    ...(instruction !== undefined && { instruction }),
    ...(schedule !== undefined && {
      schedule: schedule.kind === "once" ? { kind: "once", at: Date.parse(schedule.at) } : schedule,
    }),
    ...(catch_up !== undefined && { catchUp: catch_up }),
    ...(active !== undefined && { active }),
  };
}
