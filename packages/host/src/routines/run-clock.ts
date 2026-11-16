/**
 * The one place a run's active time is counted: the cap on a run is measured by this clock and nothing else, so whatever should
 * not count against it (a run parked at a human wait) pauses it here. It fires `onExpire` once, when `capMs` of unpaused time
 * has passed, and holds no timer once paused, cleared or expired.
 */
export type RunClock = {
  pause(): void;
  resume(): void;
  /** Unpaused time counted so far, `usedMs` it started with included. */
  activeMs(): number;
  /** Ends the clock for good: it never fires afterwards. */
  clear(): void;
};

/** `usedMs` is the active time a run already used before this clock (a run that parked and resumed): the cap's remainder is left. */
export function startRunClock(capMs: number, onExpire: () => void, usedMs = 0): RunClock {
  let left = Math.max(capMs - usedMs, 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedAt = 0;
  let done = false;

  const disarm = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  function arm() {
    armedAt = performance.now();
    timer = setTimeout(() => {
      timer = undefined;
      done = true;
      onExpire();
    }, left);
  }

  arm();
  return {
    pause() {
      if (done || timer === undefined) return;
      left = Math.max(0, left - (performance.now() - armedAt));
      disarm();
    },
    resume() {
      if (done || timer !== undefined) return;
      arm();
    },
    activeMs() {
      const remaining =
        timer === undefined ? left : Math.max(0, left - (performance.now() - armedAt));
      return capMs - remaining;
    },
    clear() {
      done = true;
      disarm();
    },
  };
}

/** The cap as the owner reads it: "30 minutes", "1 minute", or seconds and milliseconds for the small caps of tests. */
export function describeCap(capMs: number): string {
  if (capMs % 60_000 === 0) return `${capMs / 60_000} minute${capMs === 60_000 ? "" : "s"}`;
  if (capMs % 1000 === 0) return `${capMs / 1000} second${capMs === 1000 ? "" : "s"}`;
  return `${capMs} ms`;
}
