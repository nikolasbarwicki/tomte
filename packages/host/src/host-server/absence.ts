import type { Events } from "../events/index.ts";
import type { PresenceOptions } from "../presence/index.ts";
import type { Routines } from "../routines/index.ts";

/** The keys of the two notices of an absence, which the time of the owner's last action follows: one absence, one notice each. */
const WARNING = "absence-warning:";
const PAUSED = "absence-paused:";

const byBot = (items: { botId: string; name: string }[]) => {
  const names = new Map<string, string[]>();
  for (const { botId, name } of items) names.set(botId, [...(names.get(botId) ?? []), name]);
  return names;
};

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * What an absence does to routines and what the owner is told, which presence knows nothing about: the one place that joins the
 * `presence` and `routines` modules. A bot is told through a notice (a needs-you item) because it has routines the absence affects.
 */
export function absenceActions(d: {
  routines: Pick<Routines, "active" | "pauseAll" | "resumeByReason">;
  events: Pick<Events, "notice" | "resolveNotices">;
  /** Every bot that exists: the owner's return closes the notices of any of them. */
  botIds: () => string[];
}): Pick<PresenceOptions, "warn" | "pause" | "returned"> {
  return {
    warn({ since }) {
      const named = byBot(d.routines.active());
      for (const [botId, names] of named)
        d.events.notice(botId, {
          key: `${WARNING}${since}`,
          title: "Routines will pause in 2 days unless you open claudebot",
          body: `Active routines: ${names.join(", ")}.`,
        });
      return named.size > 0;
    },

    pause({ since, pauseAfterDays }) {
      for (const [botId, names] of byBot(d.routines.pauseAll("absence")))
        d.events.notice(botId, {
          key: `${PAUSED}${since}`,
          title: `Routines paused: no activity for ${days(pauseAfterDays)}`,
          body: `Paused: ${names.join(", ")}. Open claudebot to resume them.`,
        });
    },

    returned() {
      d.routines.resumeByReason("absence");
      for (const botId of d.botIds()) {
        d.events.resolveNotices(botId, WARNING);
        d.events.resolveNotices(botId, PAUSED);
      }
    },
  };
}
