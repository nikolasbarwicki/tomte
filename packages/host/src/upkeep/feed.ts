// The release feed: what a GitHub Release (or any server laid out like one) says is the newest version.
import { ReleaseManifest, SHELL_API } from "@tomte/contract/api";
import type { UpdateStatus } from "@tomte/contract/host-status";
import { ReleaseVersion } from "@tomte/contract/update";

import type { UpdateConf } from "../platform/update-conf.ts";

const FEED_TIMEOUT_MS = 15_000;

type Parsed = { core: number[]; pre: string[] };

function parse(version: string): Parsed | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (m === null) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split(".") ?? [] };
}

/** Semver precedence: a pre-release sorts below its release, numeric identifiers below alphanumeric ones. */
function precedes(a: Parsed, b: Parsed): boolean {
  for (const [i, n] of a.core.entries()) if (n !== b.core[i]) return n < (b.core[i] ?? 0);
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length > 0 && b.pre.length === 0;
  for (const [i, x] of a.pre.entries()) {
    const y = b.pre[i];
    if (y === undefined) return false;
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) < Number(y);
    return nx || (!ny && x < y);
  }
  return a.pre.length < b.pre.length;
}

/** Whether `candidate` is a version after `current`; false when either is not a release version. */
export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [parse(candidate), parse(current)];
  return a !== undefined && b !== undefined && precedes(b, a);
}

/** Asks the feed for the latest release's manifest. GitHub answers `releases/latest/download/<asset>` with a redirect to that release's asset. */
export async function latestRelease(
  conf: UpdateConf,
  fetcher: typeof fetch,
): Promise<ReleaseManifest> {
  const url = `${conf.releaseBaseUrl.replace(/\/$/, "")}/${conf.repo}/releases/latest/download/release.json`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the release feed answered ${res.status}`);
  const manifest = ReleaseManifest.parse(await res.json());
  // The version goes into a link and, later, a request to the helper; the feed's word is not enough for either.
  ReleaseVersion.parse(manifest.version);
  return manifest;
}

/**
 * What the feed's answer means for a host running `version`. `skipped` is the release the host rolled back from: when it is
 * the newest one it is reported as `skipped` on a `current` status, not offered.
 */
export function statusFor(
  conf: UpdateConf,
  version: string,
  latest: ReleaseManifest,
  checkedAt: number,
  skipped?: string,
): UpdateStatus {
  if (!isNewer(latest.version, version)) return { status: "current", checkedAt };
  const offer = {
    version: latest.version,
    notesUrl: `${conf.releaseBaseUrl.replace(/\/$/, "")}/${conf.repo}/releases/tag/v${latest.version}`,
    raisesShellApi: latest.shellApi.min > SHELL_API.min || latest.shellApi.max > SHELL_API.max,
  };
  return latest.version === skipped
    ? { status: "current", checkedAt, skipped: offer }
    : { status: "available", ...offer };
}
