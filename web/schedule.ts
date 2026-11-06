import type { Schedule } from "../src/contract/events.ts";

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
  const time = (m: string, h: string) => (Number(h) < 24 && Number(m) < 60 ? `${pad(Number(h))}:${pad(Number(m))}` : undefined);
  let m: RegExpMatchArray | null;
  if ((m = s.expr.match(/^(\d{1,2}) \* \* \* \*$/)) && Number(m[1]) < 60) return { kind: "hourly", minute: Number(m[1]) };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)) && time(m[1], m[2])) return { kind: "daily", time: time(m[1], m[2])! };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/)) && time(m[1], m[2])) return { kind: "weekdays", time: time(m[1], m[2])! };
  if ((m = s.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/)) && time(m[1], m[2]))
    return { kind: "weekly", day: Number(m[3]), time: time(m[1], m[2])! };
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
