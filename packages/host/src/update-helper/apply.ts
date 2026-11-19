import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BinaryVersion,
  REQUEST_FILE,
  RESULT_FILE,
  UPDATES_DIR,
  UpdateRequest,
  UpdateResult,
  snapshotName,
} from "@tomte/contract/update";
import { z } from "zod";

import { acquireDataRootLock } from "../platform/data-root-lock.ts";
import { dbFiles } from "../platform/db.ts";
import type { UpdateConf } from "../platform/update-conf.ts";
import { fetchVerifiedRelease, type Download } from "./verify.ts";

/** Seconds of `is-active` plus the new version on host-info that make a start stable: `deploy/install.sh`'s `STABLE_SECONDS`. */
const STABLE_SECONDS = 7;
/** Seconds the health gate waits for seven stable ones before it gives up. */
const GATE_SECONDS = 90;
const MAX_REQUEST_BYTES = 4096;

export interface Systemd {
  stop(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  isActive(): Promise<boolean>;
}

/** What the helper does inside the service user's directories. It runs as that user, so a link planted there cannot make root write elsewhere. */
export interface ServiceUser {
  /** Replaces `path` with `content` atomically. */
  writeFile(path: string, content: string): Promise<void>;
  /** Replaces the database file `files[0]` with the snapshot `snapshot` and removes the others (its `-wal` and `-shm`). */
  restoreDatabase(snapshot: string, files: string[]): Promise<void>;
}

export interface Deps {
  /** The release asset for this machine, e.g. `tomte-host-linux-x64`. */
  asset: string;
  download: Download;
  /** Runs `<binary> --version`. */
  versionOf(binary: string): Promise<BinaryVersion>;
  systemd: Systemd;
  service: ServiceUser;
  /** The version the running host reports on host-info; undefined when it does not answer. */
  hostVersion(): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** Fault injection for tests: called after each journal write. */
  journaled?(step: Step): Promise<void> | void;
}

const Step = z.enum([
  "requested",
  "saving-previous",
  "swapping",
  "restarting",
  "rolling-back",
  "finished",
]);
type Step = z.infer<typeof Step>;

/**
 * The step journal, written before each step it names so a run that dies mid-step knows where to resume.
 * `from` is the binary installed when the run began, `target` the release being installed, `revert` what a rollback restores:
 * `to`, and the database snapshot `snapshot` (a file name in the updates folder, derived from `snapshotName`, never from a request)
 * when the database goes back too.
 */
const Journal = z.object({
  request: UpdateRequest,
  step: Step,
  from: BinaryVersion,
  target: BinaryVersion.optional(),
  revert: z
    .object({ reason: z.string(), snapshot: z.string().exactOptional(), to: BinaryVersion })
    .optional(),
  result: UpdateResult.optional(),
});
type Journal = z.infer<typeof Journal>;

type Outcome = UpdateResult extends infer R
  ? R extends UpdateResult
    ? Omit<R, "requestId" | "finishedAt" | "running" | "previous">
    : never
  : never;

const exists = (path: string) =>
  lstat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** Writes `path` whole or not at all, in a root-only directory. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

type Taken = { request: UpdateRequest } | { invalid: string } | undefined;

/** Reads `request.json` without following a link, at most `MAX_REQUEST_BYTES`, and removes it: a request is handled once. */
function takeRequest(path: string): Taken {
  let dir;
  try {
    dir = lstatSync(dirname(path));
  } catch {
    return undefined;
  }
  if (!dir.isDirectory()) return { invalid: `${UPDATES_DIR} is not a directory` };
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    unlinkSync(path);
    return { invalid: `${REQUEST_FILE} could not be opened (${code})` };
  }
  let text: string | undefined;
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.size <= MAX_REQUEST_BYTES) text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
  if (text === undefined) return { invalid: `${REQUEST_FILE} is not a small regular file` };
  try {
    return { request: UpdateRequest.parse(JSON.parse(text)) };
  } catch {
    return { invalid: `${REQUEST_FILE} is not a valid update request` };
  }
}

/** Handles one update request, and finishes the one a dead run left, on this machine. See ADR-0014. */
class Updater {
  readonly #journalPath: string;
  readonly #lastRequestPath: string;
  readonly #staging: string;
  readonly #requestPath: string;
  readonly #resultPath: string;
  readonly #prev: string;

  constructor(
    readonly conf: UpdateConf,
    readonly deps: Deps,
  ) {
    this.#journalPath = join(conf.stateDir, "journal.json");
    this.#lastRequestPath = join(conf.stateDir, "last-request");
    this.#staging = join(conf.stateDir, "staging");
    this.#requestPath = join(conf.dataRoot, UPDATES_DIR, REQUEST_FILE);
    this.#resultPath = join(conf.dataRoot, UPDATES_DIR, RESULT_FILE);
    this.#prev = `${conf.bin}.prev`;
  }

  async run(): Promise<void> {
    mkdirSync(this.conf.stateDir, { recursive: true, mode: 0o700 });
    const lock = acquireDataRootLock(this.conf.stateDir);
    try {
      await this.#recover();
      const taken = takeRequest(this.#requestPath);
      if (taken === undefined) return;
      if ("invalid" in taken) {
        await this.#report("unknown", { outcome: "refused", reason: taken.invalid });
        return;
      }
      if (taken.request.id === (await this.#lastRequest())) {
        this.deps.log(`request ${taken.request.id} was already handled`);
        return;
      }
      await this.#handle(taken.request);
    } finally {
      lock.release();
    }
  }

  async #lastRequest(): Promise<string | undefined> {
    return readFile(this.#lastRequestPath, "utf8").catch(() => undefined);
  }

  async #readJournal(): Promise<Journal | undefined> {
    const text = await readFile(this.#journalPath, "utf8").catch(() => undefined);
    return text === undefined ? undefined : Journal.parse(JSON.parse(text));
  }

  async #journal(j: Journal, step: Step): Promise<void> {
    j.step = step;
    await writeAtomic(this.#journalPath, JSON.stringify(j));
    await this.deps.journaled?.(step);
  }

  async #recover(): Promise<void> {
    const j = await this.#readJournal();
    if (j === undefined) return;
    this.deps.log(`resuming request ${j.request.id} at step ${j.step}`);
    switch (j.step) {
      case "finished":
        await this.#publish(j.request.id, j.result!);
        await rm(this.#journalPath, { force: true });
        return;
      case "rolling-back":
        return this.#rollBack(j);
      case "restarting":
        return this.#restartAndGate(j);
      case "swapping": {
        const installed = await this.deps.versionOf(this.conf.bin).catch(() => undefined);
        if (installed?.version === j.target?.version) return this.#restartAndGate(j);
        return this.#handle(j.request);
      }
      case "requested":
      case "saving-previous":
        return this.#handle(j.request);
    }
  }

  async #handle(request: UpdateRequest): Promise<void> {
    let from;
    try {
      from = await this.deps.versionOf(this.conf.bin);
    } catch (e) {
      return this.#report(request.id, {
        outcome: "refused",
        reason: `could not read the installed version: ${(e as Error).message}`,
      });
    }
    const j: Journal = { request, step: "requested", from };
    await this.#journal(j, "requested");
    return request.kind === "apply" ? this.#apply(j, request.version) : this.#rollbackRequest(j);
  }

  async #apply(j: Journal, version: string): Promise<void> {
    if (j.from.version === version) return this.#finish(j, { outcome: "unchanged", version });
    const staged = await this.#stage(version, j.from);
    if (typeof staged === "string") return this.#finish(j, { outcome: "refused", reason: staged });
    j.target = staged.target;
    await this.#journal(j, "saving-previous");
    await copyFile(this.conf.bin, `${this.#prev}.new`);
    await chmod(`${this.#prev}.new`, 0o755);
    await rename(`${this.#prev}.new`, this.#prev);
    await this.#journal(j, "swapping");
    const incoming = join(dirname(this.conf.bin), ".tomte-host.new");
    await copyFile(staged.binary, incoming);
    await chmod(incoming, 0o755);
    await rename(incoming, this.conf.bin);
    await this.#journal(j, "restarting");
    return this.#restartAndGate(j);
  }

  /** Downloads and verifies `version` into the staging folder; returns a refusal reason when it cannot be trusted or must not be installed. */
  async #stage(
    version: string,
    installed: BinaryVersion,
  ): Promise<string | { binary: string; target: BinaryVersion }> {
    const { conf, deps } = this;
    try {
      await rm(this.#staging, { recursive: true, force: true });
      await mkdir(this.#staging, { recursive: true, mode: 0o700 });
      const release = await fetchVerifiedRelease({
        releaseUrl: `${conf.releaseBaseUrl.replace(/\/$/, "")}/${conf.repo}/releases/download/v${version}`,
        dest: this.#staging,
        asset: deps.asset,
        version,
        publicKey: conf.publicKey,
        download: deps.download,
      });
      const { schemaVersion } = release.manifest;
      if (schemaVersion < installed.schemaVersion)
        return `${version} migrates the database to schema ${schemaVersion}, but this database is at ${installed.schemaVersion}; an older host cannot open it`;
      await chmod(release.binary, 0o700);
      const reported = await deps.versionOf(release.binary);
      if (reported.version !== version || reported.schemaVersion !== schemaVersion)
        return `the downloaded binary reports ${reported.version} (schema ${reported.schemaVersion}), not ${version} (schema ${schemaVersion})`;
      return { binary: release.binary, target: reported };
    } catch (e) {
      return (e as Error).message;
    }
  }

  async #rollbackRequest(j: Journal): Promise<void> {
    if (!(await exists(this.#prev)))
      return this.#finish(j, { outcome: "refused", reason: "no previous version is kept" });
    let previous;
    try {
      previous = await this.deps.versionOf(this.#prev);
    } catch (e) {
      return this.#finish(j, {
        outcome: "refused",
        reason: `the previous binary does not run: ${(e as Error).message}`,
      });
    }
    const needsSnapshot = previous.schemaVersion < j.from.schemaVersion;
    const confirmed = j.request.kind === "rollback" && j.request.restoreSnapshot === true;
    if (needsSnapshot && !confirmed)
      return this.#finish(j, {
        outcome: "refused",
        reason: `${previous.version} cannot open this database (schema ${previous.schemaVersion}, database at ${j.from.schemaVersion}); restoring the snapshot taken before the update is a separate, confirmed request`,
      });
    if (confirmed && !needsSnapshot)
      return this.#finish(j, {
        outcome: "refused",
        reason: `${previous.version} opens this database (schema ${previous.schemaVersion}, database at ${j.from.schemaVersion}); restoring a snapshot would only lose changes`,
      });
    const snapshot = snapshotName(j.from.version);
    if (confirmed && !(await exists(join(this.conf.dataRoot, UPDATES_DIR, snapshot))))
      return this.#finish(j, {
        outcome: "refused",
        reason: `no database snapshot was taken before ${j.from.version} (${snapshot})`,
      });
    j.revert = {
      reason: "rollback requested",
      ...(confirmed && { snapshot }),
      to: previous,
    };
    await this.#journal(j, "rolling-back");
    return this.#rollBack(j);
  }

  async #restartAndGate(j: Journal): Promise<void> {
    const target = j.target!;
    let failure: string | undefined;
    try {
      await this.deps.systemd.restart();
    } catch (e) {
      failure = `could not restart ${this.conf.service}: ${(e as Error).message}`;
    }
    failure ??= await this.#gate(target.version);
    if (failure === undefined)
      return this.#finish(j, { outcome: "updated", from: j.from.version, version: target.version });
    const snapshot = snapshotName(target.version);
    j.revert = {
      reason: failure,
      ...((await exists(join(this.conf.dataRoot, UPDATES_DIR, snapshot))) && { snapshot }),
      to: j.from,
    };
    await this.#journal(j, "rolling-back");
    return this.#rollBack(j);
  }

  /** Puts the previous binary back (and the database snapshot, for an automatic rollback) and requires the same health gate of it. */
  async #rollBack(j: Journal): Promise<void> {
    const revert = j.revert!;
    const { conf, deps } = this;
    const automatic = j.request.kind === "apply";
    try {
      await deps.systemd.stop();
      if (revert.snapshot !== undefined) {
        const snapshot = join(conf.dataRoot, UPDATES_DIR, revert.snapshot);
        await deps.service.restoreDatabase(snapshot, dbFiles(conf.dataRoot));
      }
      if (await exists(this.#prev)) await rename(this.#prev, conf.bin);
      await deps.systemd.start();
    } catch (e) {
      return this.#finish(j, {
        outcome: "failed",
        reason: `could not restore ${revert.to.version}: ${(e as Error).message}${automatic ? ` (after: ${revert.reason})` : ""}`,
      });
    }
    const failure = await this.#gate(revert.to.version);
    if (failure !== undefined)
      return this.#finish(j, {
        outcome: "failed",
        reason: `${revert.to.version} did not become healthy after the rollback: ${failure}${automatic ? ` (after: ${revert.reason})` : ""}`,
      });
    if (!automatic)
      return this.#finish(j, {
        outcome: "rolled-back",
        from: j.from.version,
        version: revert.to.version,
        snapshotRestored: revert.snapshot !== undefined,
      });
    return this.#finish(j, {
      outcome: "reverted",
      version: j.target!.version,
      reason: revert.reason,
      rolledBackTo: revert.to.version,
      snapshotRestored: revert.snapshot !== undefined,
    });
  }

  /** Waits for `STABLE_SECONDS` in a row of an active service whose host-info reports `version`; undefined when it got them, else why not. */
  async #gate(version: string): Promise<string | undefined> {
    const { deps } = this;
    let stable = 0;
    let why = "the service never became active";
    for (let second = 0; second < GATE_SECONDS; second++) {
      await deps.sleep(1000);
      const active = await deps.systemd.isActive().catch(() => false);
      const reported = active ? await deps.hostVersion().catch(() => undefined) : undefined;
      if (active && reported === version) {
        if (++stable >= STABLE_SECONDS) return undefined;
        continue;
      }
      stable = 0;
      why = active
        ? `host-info reports ${reported ?? "nothing"}, not ${version}`
        : "the service is not active";
    }
    return `${why}; no ${STABLE_SECONDS} stable seconds within ${GATE_SECONDS}`;
  }

  async #finish(j: Journal, outcome: Outcome): Promise<void> {
    j.result = await this.#withState(j.request.id, outcome);
    await this.#journal(j, "finished");
    await this.#publish(j.request.id, j.result);
    await rm(this.#journalPath, { force: true });
  }

  /** The result of a request that never reached the journal. */
  async #report(requestId: string, outcome: Outcome): Promise<void> {
    await this.#publish(requestId, await this.#withState(requestId, outcome));
  }

  async #withState(requestId: string, outcome: Outcome): Promise<UpdateResult> {
    const running = await this.deps.versionOf(this.conf.bin).catch(() => undefined);
    const previous = (await exists(this.#prev))
      ? await this.deps.versionOf(this.#prev).catch(() => undefined)
      : undefined;
    return {
      ...outcome,
      requestId,
      finishedAt: this.deps.now(),
      running,
      previous,
    } as UpdateResult;
  }

  /** Hands the result to the host and remembers the request as handled; a request id is handled once. */
  async #publish(requestId: string, result: UpdateResult): Promise<void> {
    await rm(this.#staging, { recursive: true, force: true });
    await writeAtomic(this.#lastRequestPath, requestId);
    try {
      await this.deps.service.writeFile(this.#resultPath, JSON.stringify(result));
    } catch (e) {
      this.deps.log(`could not write ${this.#resultPath}: ${(e as Error).message}`);
    }
    this.deps.log(`request ${requestId}: ${result.outcome}`);
  }
}

/**
 * The helper's whole run, as root: finishes the update a dead run left in the journal, then handles the request in
 * `<dataRoot>/updates/request.json` if there is one. All the machine's inputs are in `conf` and `deps`; the request is the only
 * thing the service user supplies, and it is a version or "rollback".
 */
export function runUpdate(conf: UpdateConf, deps: Deps): Promise<void> {
  return new Updater(conf, deps).run();
}
