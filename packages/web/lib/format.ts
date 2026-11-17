export const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

const compact = new Intl.NumberFormat([], { notation: "compact", maximumFractionDigits: 1 });

/** A token count as people read it: 840, 12k, 1.2M. */
export const tokenCount = (n: number) => compact.format(n);

/** A span of time to the unit that matters: "45 s", "12 min", "3 h 5 min". */
export const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

export const fileSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** Clock time for today, weekday within the past week, otherwise the date. */
export const shortTime = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const daysAgo = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (daysAgo === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (daysAgo > 0 && daysAgo < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
};

/** Date and time without seconds, e.g. "Nov 6, 09:30"; the year shows only when it is not this year. */
export const dateTime = (t: number) => {
  const d = new Date(t);
  return d.toLocaleString([], {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** The clock time alone, hours and minutes, e.g. "09:30". */
export const clockTime = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
