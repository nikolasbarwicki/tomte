import { expect, test } from "bun:test";

import type { Routine, Schedule } from "@claudebot/contract/events";

import {
  browserZone,
  describe as describeSchedule,
  formFromRoutine,
  fromSchedule,
  localInput,
  presetFromForm,
  toSchedule,
  type FormFields,
  type Preset,
} from "./schedule.ts";

const TZ = "Europe/Warsaw";
const cron = (expr: string): Schedule => ({ kind: "cron", expr, tz: TZ });

const routine = (schedule: Schedule, over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  botId: "b1",
  name: "Digest",
  instruction: "Summarise",
  schedule,
  active: true,
  pausedReason: null,
  catchUp: false,
  notifyResult: false,
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: null,
  lastRun: null,
  running: false,
  ...over,
});

test("every preset compiles to the cron the host expects, `once` stays a timestamp", () => {
  expect(toSchedule({ kind: "hourly", minute: 5 }, TZ)).toEqual(cron("5 * * * *"));
  expect(toSchedule({ kind: "daily", time: "09:30" }, TZ)).toEqual(cron("30 9 * * *"));
  expect(toSchedule({ kind: "weekdays", time: "08:00" }, TZ)).toEqual(cron("0 8 * * 1-5"));
  expect(toSchedule({ kind: "weekly", day: 3, time: "17:45" }, TZ)).toEqual(cron("45 17 * * 3"));
  expect(toSchedule({ kind: "custom", expr: "  */5 * * * *  " }, TZ)).toEqual(cron("*/5 * * * *"));
  expect(toSchedule({ kind: "once", at: 1_700_000_000_000 }, TZ)).toEqual({
    kind: "once",
    at: 1_700_000_000_000,
  });
});

test("toSchedule defaults the time zone to the browser's", () => {
  expect(toSchedule({ kind: "hourly", minute: 0 })).toEqual({
    kind: "cron",
    expr: "0 * * * *",
    tz: browserZone(),
  });
});

test("fromSchedule recognises what toSchedule produces", () => {
  const presets: Preset[] = [
    { kind: "hourly", minute: 5 },
    { kind: "daily", time: "09:30" },
    { kind: "weekdays", time: "08:00" },
    { kind: "weekly", day: 0, time: "17:45" },
    { kind: "once", at: 1_700_000_000_000 },
  ];
  for (const p of presets) expect(fromSchedule(toSchedule(p, TZ))).toEqual(p);
});

test("fromSchedule keeps anything it cannot edit as a custom cron", () => {
  expect(fromSchedule(cron("*/5 * * * *"))).toEqual({ kind: "custom", expr: "*/5 * * * *" });
  expect(fromSchedule(cron("0 9 * * 1,3"))).toEqual({ kind: "custom", expr: "0 9 * * 1,3" });
  expect(fromSchedule(cron("0 24 * * *"))).toEqual({ kind: "custom", expr: "0 24 * * *" });
  expect(fromSchedule(cron("60 * * * *"))).toEqual({ kind: "custom", expr: "60 * * * *" });
});

test("describe words each schedule, with the time zone for cron ones", () => {
  expect(describeSchedule(cron("5 * * * *"))).toBe(`Hourly at :05 (${TZ})`);
  expect(describeSchedule(cron("30 9 * * *"))).toBe(`Daily at 09:30 (${TZ})`);
  expect(describeSchedule(cron("0 8 * * 1-5"))).toBe(`Weekdays at 08:00 (${TZ})`);
  expect(describeSchedule(cron("45 17 * * 3"))).toBe(`Wednesdays at 17:45 (${TZ})`);
  expect(describeSchedule(cron("*/5 * * * *"))).toBe(`Cron */5 * * * * (${TZ})`);
  expect(describeSchedule({ kind: "once", at: 1_700_000_000_000 })).toBe(
    `Once on ${new Date(1_700_000_000_000).toLocaleString()}`,
  );
});

test("localInput formats local time for a datetime-local input and round-trips", () => {
  const t = new Date(2026, 0, 5, 7, 3).getTime();
  expect(localInput(t)).toBe("2026-01-05T07:03");
  expect(new Date(localInput(t)).getTime()).toBe(t);
});

test("a new routine's form starts as daily 09:00 in the browser zone, once-time an hour out", () => {
  const now = new Date(2026, 0, 5, 7, 3).getTime();
  expect(formFromRoutine(undefined, now)).toEqual({
    name: "",
    instruction: "",
    kind: "daily",
    minute: 0,
    time: "09:00",
    day: 1,
    at: "2026-01-05T08:03",
    expr: "0 9 * * *",
    tz: browserZone(),
    catchUp: true,
    notifyResult: false,
  });
});

test("an edited routine's form starts from its own schedule", () => {
  const weekly = formFromRoutine(
    routine(cron("45 17 * * 3"), { catchUp: true, notifyResult: true }),
  );
  expect(weekly).toMatchObject({
    name: "Digest",
    instruction: "Summarise",
    kind: "weekly",
    day: 3,
    time: "17:45",
    tz: TZ,
    catchUp: true,
    notifyResult: true,
  });

  const hourly = formFromRoutine(routine(cron("5 * * * *")));
  expect(hourly).toMatchObject({
    kind: "hourly",
    minute: 5,
    time: "09:00",
    catchUp: false,
    notifyResult: false,
  });

  const custom = formFromRoutine(routine(cron("*/5 * * * *")));
  expect(custom).toMatchObject({ kind: "custom", expr: "*/5 * * * *", tz: TZ });

  const at = new Date(2026, 5, 1, 12, 30).getTime();
  const once = formFromRoutine(routine({ kind: "once", at }));
  expect(once).toMatchObject({ kind: "once", at: "2026-06-01T12:30", tz: browserZone() });
});

test("presetFromForm reads only the fields its kind uses", () => {
  const base: FormFields = {
    name: "",
    instruction: "",
    kind: "daily",
    minute: 7,
    time: "10:15",
    day: 4,
    at: "2026-06-01T12:30",
    expr: "1 2 3 4 5",
    tz: TZ,
    catchUp: true,
    notifyResult: false,
  };
  expect(presetFromForm({ ...base, kind: "hourly" })).toEqual({ kind: "hourly", minute: 7 });
  expect(presetFromForm({ ...base, kind: "daily" })).toEqual({ kind: "daily", time: "10:15" });
  expect(presetFromForm({ ...base, kind: "weekdays" })).toEqual({
    kind: "weekdays",
    time: "10:15",
  });
  expect(presetFromForm({ ...base, kind: "weekly" })).toEqual({
    kind: "weekly",
    day: 4,
    time: "10:15",
  });
  expect(presetFromForm({ ...base, kind: "once" })).toEqual({
    kind: "once",
    at: new Date(2026, 5, 1, 12, 30).getTime(),
  });
  expect(presetFromForm({ ...base, kind: "custom" })).toEqual({
    kind: "custom",
    expr: "1 2 3 4 5",
  });
});
