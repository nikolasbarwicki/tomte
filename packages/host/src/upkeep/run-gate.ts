/**
 * What an update closes while it waits for work to end and while the helper replaces the binary. Closed: new turns are refused and
 * routines wait (the code that starts them asks `closed()`); work already running is not touched and counts in `active()`.
 */
export interface RunGate {
  closed(): boolean;
  /** Units of work still running: turns, double-loop fronts with work in flight and headless runs. */
  active(): number;
  close(): void;
  /** Reopens the gate; what waited for it (routines that came due) is caught up. */
  open(): void;
  /** Called with the new count whenever it changes while the gate is closed. Returns what stops it. */
  onChange(listener: (active: number) => void): () => void;
}

/**
 * The gate an update closes: while it is closed new turns are refused and routines wait (the callers check `closed()`), and `active()` says how
 * much work is still running. The count is read once a second while the gate is closed rather than pushed from every place work
 * ends, so no way for work to end can be forgotten and leave a drain waiting for ever.
 */
export function createRunGate(o: {
  active: () => number;
  pollMs?: number;
  opened?: () => void;
}): RunGate & {
  /** Ends the polling, for a host that is closing and whose work can no longer be counted. */ stop(): void;
} {
  const listeners = new Set<(active: number) => void>();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = -1;

  const poll = () => {
    const n = o.active();
    if (n === last) return;
    last = n;
    for (const l of listeners) l(n);
  };

  return {
    closed: () => closed,
    active: o.active,
    close() {
      if (closed) return;
      closed = true;
      last = -1;
      timer = setInterval(poll, o.pollMs ?? 1000);
      timer.unref();
    },
    open() {
      if (!closed) return;
      closed = false;
      clearInterval(timer);
      timer = undefined;
      o.opened?.();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
