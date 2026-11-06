export const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

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
