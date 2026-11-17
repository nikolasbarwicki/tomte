import type { Routine, Schedule } from "@tomte/contract/events";

/** Editor-friendly shapes; every preset except `once` compiles to cron. `time` is "HH:MM", `day` is 0 (Sunday) to 6. */
export type Preset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "once"; at: number }
  | { kind: "custom"; expr: string };

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, "0");

function cronTime(time: string) {
  const [h = "0", m = "0"] = time.split(":");
  return `${Number(m)} ${Number(h)}`;
}

export function toSchedule(p: Preset, tz = browserZone()): Schedule {
  switch (p.kind) {
    case "once":
      return { kind: "once", at: p.at };
    case "hourly":
      return { kind: "cron", expr: `${p.minute} * * * *`, tz };
    case "daily":
      return { kind: "cron", expr: `${cronTime(p.time)} * * *`, tz };
    case "weekdays":
      return { kind: "cron", expr: `${cronTime(p.time)} * * 1-5`, tz };
    case "weekly":
      return { kind: "cron", expr: `${cronTime(p.time)} * * ${p.day}`, tz };
    case "custom":
      return { kind: "cron", expr: p.expr.trim(), tz };
  }
}

export function fromSchedule(s: Schedule): Preset {
  if (s.kind === "once") return { kind: "once", at: s.at };
  const time = (m: string | undefined, h: string | undefined) =>
    m !== undefined && h !== undefined && Number(h) < 24 && Number(m) < 60
      ? `${pad(Number(h))}:${pad(Number(m))}`
      : undefined;
  let m: RegExpMatchArray | null;
  let t: string | undefined;
  if ((m = s.expr.match(/^(\d{1,2}) \* \* \* \*$/)) && Number(m[1]) < 60)
    return { kind: "hourly", minute: Number(m[1]) };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)) && (t = time(m[1], m[2])))
    return { kind: "daily", time: t };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/)) && (t = time(m[1], m[2])))
    return { kind: "weekdays", time: t };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/)) && (t = time(m[1], m[2])))
    return { kind: "weekly", day: Number(m[3]), time: t };
  return { kind: "custom", expr: s.expr };
}

export function describe(s: Schedule): string {
  const p = fromSchedule(s);
  if (p.kind === "once") return `Once on ${new Date(p.at).toLocaleString()}`;
  const tz = s.kind === "cron" ? ` (${s.tz})` : "";
  switch (p.kind) {
    case "hourly":
      return `Hourly at :${pad(p.minute)}${tz}`;
    case "daily":
      return `Daily at ${p.time}${tz}`;
    case "weekdays":
      return `Weekdays at ${p.time}${tz}`;
    case "weekly":
      return `${DAYS[p.day]}s at ${p.time}${tz}`;
    case "custom":
      return `Cron ${p.expr}${tz}`;
  }
}

/** Epoch ms to the local "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
export function localInput(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Everything the routine form edits, one field per input; `at` is a datetime-local string. */
export type FormFields = {
  name: string;
  instruction: string;
  kind: Preset["kind"];
  minute: number;
  time: string;
  day: number;
  at: string;
  expr: string;
  tz: string;
  catchUp: boolean;
  notifyResult: boolean;
};

/** The form's starting values: the routine being edited, or a daily 09:00 default that first fires an hour from `now` when once. */
export function formFromRoutine(routine?: Routine, now = Date.now()): FormFields {
  const initial: Preset = routine
    ? fromSchedule(routine.schedule)
    : { kind: "daily", time: "09:00" };
  return {
    name: routine?.name ?? "",
    instruction: routine?.instruction ?? "",
    kind: initial.kind,
    minute: initial.kind === "hourly" ? initial.minute : 0,
    time: "time" in initial ? initial.time : "09:00",
    day: initial.kind === "weekly" ? initial.day : 1,
    at: localInput(initial.kind === "once" ? initial.at : now + 60 * 60_000),
    expr:
      initial.kind === "custom"
        ? initial.expr
        : routine?.schedule.kind === "cron"
          ? routine.schedule.expr
          : "0 9 * * *",
    tz: routine?.schedule.kind === "cron" ? routine.schedule.tz : browserZone(),
    catchUp: routine?.catchUp ?? true,
    notifyResult: routine?.notifyResult ?? false,
  };
}

/** The preset the form currently describes: only the fields its `kind` uses are read. */
export function presetFromForm({ kind, minute, day, time, at, expr }: FormFields): Preset {
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "weekly":
      return { kind, day, time };
    case "daily":
    case "weekdays":
      return { kind, time };
    case "once":
      return { kind, at: new Date(at).getTime() };
    case "custom":
      return { kind, expr };
  }
}
