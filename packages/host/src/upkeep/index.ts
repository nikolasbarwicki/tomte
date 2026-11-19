import { randomUUID } from "node:crypto";
// Upkeep owns the host's own updates (ADR-0014; spec `.scratch/client-host-split/spec.md`, phases 7 and 8). It reads the update
// helper's root-owned configuration, asks the release feed for the newest version on start and every few hours, and keeps the answer
// as an `UpdateStatus`. When told to update it closes the run gate, waits for running work (or does not, for "now"), snapshots the
// database, hands the helper a request and turns the helper's result into `current` or `failed`. It imports only the platform and
// the contract.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { UpdateStatus } from "@tomte/contract/host-status";
import { snapshotName, type UpdateAction, type UpdateResult } from "@tomte/contract/update";

import { DEFAULT_CONF_PATH, parseUpdateConf, type UpdateConf } from "../platform/update-conf.ts";
import { isNewer, latestRelease, statusFor } from "./feed.ts";
import { createUpdateRequests } from "./requests.ts";
import type { RunGate } from "./run-gate.ts";

export { createRunGate, type RunGate } from "./run-gate.ts";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

/** The action does not apply to the host as it is now (nothing to update to, no helper, an update already under way); the message says why. */
export class UpdateRefused extends Error {}

export interface UpkeepOptions {
  /** This host's version, which the feed's newest release is compared with. */
  version: string;
  /** The desktop app replaces its sidecar's binary, so nothing here updates it. */
  sidecar: boolean;
  /** The service's data root; the helper must be configured for this one or it never sees the host's requests. */
  dataRoot: string;
  /** The helper's configuration file; the one `install.sh` writes when omitted. */
  confPath?: string;
  /** How often the feed is asked; six hours when omitted. */
  checkEveryMs?: number;
  /** The feed's HTTP client; `fetch` when omitted. */
  fetch?: typeof fetch;
  /** The clock for `checkedAt` and for when a drain began; the system's when omitted. */
  now?: () => number;
  log?: (line: string) => void;
  /** The gate an update closes; see `RunGate`. */
  gate: RunGate;
  /** Writes a consistent copy of the database to the path, which an automatic rollback restores. */
  snapshot(path: string): void | Promise<void>;
  /** How long a drain may wait for running work before it says it is overdue; 30 minutes when omitted. */
  drainOverdueMs?: number;
  /** How often the helper's result is looked for while an update is applying; a second when omitted. */
  resultPollMs?: number;
  /** How long the helper may take to answer before the update counts as failed; 10 minutes when omitted. */
  applyTimeoutMs?: number;
}

export interface Upkeep {
  status(): UpdateStatus;
  /** Whether an available update is applied when idle without being asked. */
  autoUpdate(): boolean;
  /**
   * The earlier version this host can go back to, when there is one: `rollback` when it opens the current database, `restore` when
   * it needs the database copy taken before the update (`snapshotAt`) and so the owner's explicit confirmation. Undefined while an
   * update or rollback is under way or has failed, when the helper keeps no previous binary, and on a host that cannot update itself.
   */
  rollbackOffer(): RollbackOffer | undefined;
  /** Called when the status changes, a later `checkedAt` included, and when the auto-update setting does. Returns what stops it. */
  onChange(listener: (status: UpdateStatus) => void): () => void;
  /**
   * Does what the owner asked and resolves to the status afterwards; rejects with `UpdateRefused` when it does not apply. `apply` with
   * `when: "idle"` resolves as soon as the host is draining (the update then goes on by itself); with `when: "now"` once the request
   * is with the helper.
   */
  run(action: UpdateAction): Promise<UpdateStatus>;
  /**
   * Looks for an update the last process left under way (or its failure), then checks now and every `checkEveryMs`. Nothing when the
   * desktop app updates this host.
   */
  start(): void;
  /** One check of the feed; resolves once the status is up to date with the answer. A feed that cannot be reached changes nothing and is logged. */
  check(): Promise<UpdateStatus>;
  stop(): void;
}

const UNMANAGED = "this host has no update helper installed";

function readConf(path: string, dataRoot: string): UpdateConf | string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? UNMANAGED
      : `the update helper's configuration (${path}) cannot be read`;
  }
  try {
    const conf = parseUpdateConf(text);
    return conf.dataRoot === dataRoot
      ? conf
      : `the update helper is set up for another data root (${conf.dataRoot})`;
  } catch (e) {
    return `the update helper's configuration (${path}) is invalid: ${(e as Error).message}`;
  }
}

type Available = Extract<UpdateStatus, { status: "available" }>;

/** What `Upkeep.rollbackOffer` says: the version to go back to, and whether that means restoring the database copy taken at `snapshotAt`. */
type RollbackOffer =
  | { kind: "rollback"; version: string }
  | { kind: "restore"; version: string; snapshotAt: number };

/** What an update under way does: go forward to `version`, or (with `rollback`) back to it, restoring the database snapshot when asked to. */
interface Plan {
  version: string;
  rollback?: { restoreSnapshot: boolean };
}

export function createUpkeep(o: UpkeepOptions): Upkeep {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line) => console.error(line));
  const { gate } = o;
  const requests = createUpdateRequests(o.dataRoot);
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status: UpdateStatus = o.sidecar
    ? { status: "bundled" }
    : { status: "unmanaged", reason: UNMANAGED };
  let autoUpdate = !o.sidecar && requests.state().autoUpdate;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<UpdateStatus> | undefined;
  /** What the status offered when an update began, so cancelling a drain puts it back. */
  let offered: Available | undefined;
  /** What the drain or the applying update is for, so ending the drain early does the same thing. */
  let plan: Plan | undefined;
  /** What a drain waits on: the gate's count and the 30-minute mark. */
  let drain: { stop(): void } | undefined;
  /** What an applying update waits on: the helper's result, and the time it has to come. */
  let waitingForResult: { stop(): void } | undefined;
  let starting = false;

  const notify = () => {
    for (const l of listeners) l(status);
  };
  const set = (next: UpdateStatus) => {
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    notify();
  };
  /** An update is under way or has failed and not been acknowledged: the feed's answer must not replace that. */
  const engaged = () =>
    status.status === "draining" || status.status === "applying" || status.status === "failed";
  const setPending = (pending: { id: string; version: string; rollback?: true } | undefined) => {
    const { pending: _, ...rest } = requests.state();
    requests.saveState({ ...rest, ...(pending && { pending }) });
  };
  /** The release this host rolled back from, or nothing: the feed names a newer one, or this host runs it again. */
  const setSkipped = (version: string | undefined) => {
    const { skipped: _, ...rest } = requests.state();
    requests.saveState({ ...rest, ...(version !== undefined && { skipped: version }) });
  };

  const endDrain = () => {
    drain?.stop();
    drain = undefined;
  };
  const endWaiting = () => {
    waitingForResult?.stop();
    waitingForResult = undefined;
  };

  const failed = (version: string, reason: string, rolledBackTo?: string, rollback?: true) => {
    gate.open();
    set({
      status: "failed",
      version,
      reason,
      ...(rolledBackTo !== undefined && { rolledBackTo }),
      ...(rollback && { rollback }),
    });
  };

  /**
   * The helper answered the request this host wrote. A failure stays (and is remembered across the restart a rollback causes)
   * until it is acknowledged. `live` is the process that wrote the request: an `updated` or `rolled-back` result means the helper
   * has replaced or is about to replace this process, so it keeps the gate closed and keeps waiting; the process that starts
   * afterwards finds the result in `recover()` and goes `current`.
   */
  const settle = (
    pending: { id: string; version: string; rollback?: true },
    result: UpdateResult,
    live: boolean,
  ) => {
    if (live && (result.outcome === "updated" || result.outcome === "rolled-back")) return;
    endWaiting();
    switch (result.outcome) {
      case "updated":
      case "unchanged":
      case "rolled-back":
        setPending(undefined);
        // Going back is a decision to stay: the release just left is not offered or applied by itself again.
        if (result.outcome === "rolled-back") setSkipped(result.from);
        gate.open();
        set({ status: "current", checkedAt: 0 });
        void check();
        return;
      case "reverted":
        return failed(pending.version, result.reason, result.rolledBackTo, pending.rollback);
      case "refused":
      case "failed":
        return failed(pending.version, result.reason, undefined, pending.rollback);
    }
  };

  /** Applying: waits for the result of `pending` to appear, for at most `applyTimeoutMs`. */
  const waitForResult = (pending: { id: string; version: string; rollback?: true }) => {
    endWaiting();
    const poll = setInterval(() => {
      const result = requests.result();
      if (result?.requestId === pending.id) settle(pending, result, true);
    }, o.resultPollMs ?? 1000);
    const deadline = setTimeout(() => {
      endWaiting();
      failed(
        pending.version,
        "the update helper did not report a result within 10 minutes",
        undefined,
        pending.rollback,
      );
    }, o.applyTimeoutMs ?? TEN_MINUTES);
    poll.unref();
    deadline.unref();
    waitingForResult = {
      stop() {
        clearInterval(poll);
        clearTimeout(deadline);
      },
    };
  };

  /** Snapshots the database (an update only), writes the request and waits for the helper. The gate stays closed until the helper answers or the host is replaced. */
  async function startApplying(p: Plan): Promise<UpdateStatus> {
    if (starting) return status;
    starting = true;
    endDrain();
    gate.close();
    plan = p;
    const rollback = p.rollback ? { rollback: true as const } : {};
    set({ status: "applying", version: p.version, ...rollback });
    try {
      const pending = { id: randomUUID(), version: p.version, ...rollback };
      if (p.rollback) {
        // Remembered before the request exists, so a restart that finds the request knows whose result to wait for.
        setPending(pending);
        requests.request({
          kind: "rollback",
          id: pending.id,
          ...(p.rollback.restoreSnapshot && { restoreSnapshot: true as const }),
        });
      } else {
        await o.snapshot(join(requests.dir, snapshotName(p.version)));
        requests.pruneSnapshots(snapshotName(p.version));
        setPending(pending);
        requests.request({ kind: "apply", id: pending.id, version: p.version });
      }
      waitForResult(pending);
    } catch (e) {
      log(
        `[upkeep] could not start the ${p.rollback ? "rollback" : "update"} to ${p.version}: ${(e as Error).message}`,
      );
      setPending(undefined);
      failed(
        p.version,
        `the host could not prepare the ${p.rollback ? "rollback" : "update"}: ${(e as Error).message}`,
        undefined,
        p.rollback ? true : undefined,
      );
    } finally {
      starting = false;
    }
    return status;
  }

  /** Closes the gate and, once nothing runs (at once for "now"), applies. */
  function begin(p: Plan, when: "idle" | "now"): Promise<UpdateStatus> {
    offered = status.status === "available" ? status : undefined;
    gate.close();
    if (when === "now" || gate.active() === 0) return startApplying(p);
    plan = p;
    set({
      status: "draining",
      version: p.version,
      running: gate.active(),
      since: now(),
      overdue: false,
      ...(p.rollback && { rollback: true as const }),
    });
    const overdue = setTimeout(() => {
      if (status.status === "draining") set({ ...status, overdue: true });
    }, o.drainOverdueMs ?? THIRTY_MINUTES);
    overdue.unref();
    const unwatch = gate.onChange((active) => {
      if (status.status !== "draining") return;
      if (active === 0) void startApplying(p);
      else set({ ...status, running: active });
    });
    drain = {
      stop() {
        clearTimeout(overdue);
        unwatch();
      },
    };
    return Promise.resolve(status);
  }

  const refuseUnmanaged = (): never => {
    throw new UpdateRefused(
      status.status === "unmanaged"
        ? status.reason
        : "the desktop app updates this host, not the host itself",
    );
  };

  function apply(when: "idle" | "now"): Promise<UpdateStatus> {
    switch (status.status) {
      case "available":
        return begin({ version: status.version }, when);
      case "failed":
        if (status.rollback)
          throw new UpdateRefused("the rollback failed; dismiss it, then ask again");
        return begin({ version: status.version }, when);
      case "draining":
        return when === "now"
          ? startApplying(plan ?? { version: status.version })
          : Promise.resolve(status);
      case "applying":
        return Promise.resolve(status);
      case "current":
        // The release the host rolled back from is not offered, but asking for it by name is an explicit install.
        if (status.skipped) return begin({ version: status.skipped.version }, when);
        throw new UpdateRefused("there is no newer release to update to");
      default:
        return refuseUnmanaged();
    }
  }

  function rollbackOffer(): RollbackOffer | undefined {
    if (status.status !== "current" && status.status !== "available") return undefined;
    // The helper's last result says what it found installed: the binaries' own `version` output, which is also what it judges a
    // rollback by. A result about another version of this host (installed by hand since) says nothing about it.
    const { running, previous } = requests.result() ?? {};
    if (running?.version !== o.version || previous === undefined) return undefined;
    if (previous.version === running.version || previous.schemaVersion > running.schemaVersion)
      return undefined;
    if (previous.schemaVersion === running.schemaVersion)
      return { kind: "rollback", version: previous.version };
    const snapshotAt = requests.snapshotTime(snapshotName(running.version));
    return snapshotAt === undefined
      ? undefined
      : { kind: "restore", version: previous.version, snapshotAt };
  }

  function rollback(when: "idle" | "now", restoreSnapshot: boolean): Promise<UpdateStatus> {
    if (o.sidecar || status.status === "unmanaged") return Promise.resolve(refuseUnmanaged());
    if (status.status === "draining" || status.status === "applying")
      throw new UpdateRefused("an update is already under way");
    if (status.status === "failed")
      throw new UpdateRefused("dismiss the failed update first, then ask again");
    const offer = rollbackOffer();
    if (offer === undefined)
      throw new UpdateRefused("there is no earlier version this host can go back to");
    if (offer.kind === "restore" && !restoreSnapshot)
      throw new UpdateRefused(
        `${offer.version} cannot open this host's database. Going back means restoring the copy taken ${new Date(offer.snapshotAt).toISOString()}, before the update, and losing every change since; ask for that explicitly`,
      );
    if (offer.kind === "rollback" && restoreSnapshot)
      throw new UpdateRefused(
        `${offer.version} opens this host's database; nothing needs restoring`,
      );
    return begin({ version: offer.version, rollback: { restoreSnapshot } }, when);
  }

  async function cancel(): Promise<UpdateStatus> {
    switch (status.status) {
      case "draining": {
        endDrain();
        gate.open();
        if (offered) set(offered);
        else {
          set({ status: "current", checkedAt: 0 });
          await check();
        }
        return status;
      }
      case "failed":
        setPending(undefined);
        set({ status: "current", checkedAt: 0 });
        return check();
      case "applying":
        throw new UpdateRefused("the update has started and cannot be cancelled");
      default:
        return status;
    }
  }

  async function setAuto(enabled: boolean): Promise<UpdateStatus> {
    if (o.sidecar || status.status === "unmanaged") return refuseUnmanaged();
    requests.saveState({ ...requests.state(), autoUpdate: enabled });
    autoUpdate = enabled;
    notify();
    if (enabled) applyAvailable();
    return status;
  }

  /** With auto-update on, an update the feed offers is applied when idle, the way the owner would. */
  function applyAvailable() {
    if (!autoUpdate || status.status !== "available") return;
    begin({ version: status.version }, "idle").catch((e: Error) =>
      log(`[upkeep] automatic update failed to start: ${e.message}`),
    );
  }

  const checkFeed = async (): Promise<UpdateStatus> => {
    const conf = readConf(o.confPath ?? DEFAULT_CONF_PATH, o.dataRoot);
    if (typeof conf === "string") {
      if (!engaged()) set({ status: "unmanaged", reason: conf });
      return status;
    }
    if (engaged()) return status;
    // Managed, but the feed has not answered: nothing is known, which `checkedAt: 0` says.
    if (status.status === "unmanaged") set({ status: "current", checkedAt: 0 });
    try {
      const latest = await latestRelease(conf, o.fetch ?? fetch);
      // The skip ends when a newer release is out, or when this host runs the skipped one after all.
      let { skipped } = requests.state();
      if (
        skipped !== undefined &&
        (isNewer(latest.version, skipped) || !isNewer(skipped, o.version))
      ) {
        setSkipped(undefined);
        skipped = undefined;
      }
      // An update may have begun while the feed was being asked.
      if (!engaged()) set(statusFor(conf, o.version, latest, now(), skipped));
    } catch (e) {
      log(`[upkeep] could not check ${conf.repo} for a newer release: ${(e as Error).message}`);
    }
    applyAvailable();
    return status;
  };

  const check = (): Promise<UpdateStatus> => {
    if (o.sidecar) return Promise.resolve(status);
    running ??= checkFeed().finally(() => {
      running = undefined;
    });
    return running;
  };

  /** A request the last process wrote: its result may be there now, or still to come while the helper restarts or verifies this host. */
  function recover() {
    if (typeof readConf(o.confPath ?? DEFAULT_CONF_PATH, o.dataRoot) === "string") return;
    const { pending } = requests.state();
    if (!pending) return;
    const result = requests.result();
    if (result?.requestId === pending.id) return settle(pending, result, false);
    gate.close();
    set({
      status: "applying",
      version: pending.version,
      ...(pending.rollback && { rollback: true as const }),
    });
    waitForResult(pending);
  }

  return {
    status: () => status,
    autoUpdate: () => autoUpdate,
    rollbackOffer,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run(action) {
      switch (action.op) {
        case "check":
          return check();
        case "apply":
          return Promise.resolve().then(() => apply(action.when));
        case "rollback":
          return Promise.resolve().then(() => rollback(action.when, action.restoreSnapshot));
        case "cancel":
          return cancel();
        case "auto":
          return setAuto(action.enabled);
      }
    },
    start() {
      if (o.sidecar || timer !== undefined) return;
      recover();
      void check();
      timer = setInterval(() => void check(), o.checkEveryMs ?? SIX_HOURS);
      timer.unref();
    },
    check,
    stop() {
      clearInterval(timer);
      timer = undefined;
      endDrain();
      endWaiting();
      listeners.clear();
    },
  };
}
