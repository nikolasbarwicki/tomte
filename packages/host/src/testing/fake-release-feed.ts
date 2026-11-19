// A release directory served the way GitHub serves releases, for tests of what a host learns about newer versions:
// `{base}/{repo}/releases/latest/download/release.json` redirects to the latest release's own asset, 404 with none.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReleaseManifest } from "@tomte/contract/api";

export const FEED_REPO = "owner/tomte";

export interface FakeReleaseFeed {
  /** The base URL an `update.conf` names as `RELEASE_BASE_URL`. */
  url: string;
  /** Publishes a release and makes it the latest. */
  publish(version: string, shellApi?: ReleaseManifest["shellApi"]): void;
  /** The feed answers with this status until `answer(undefined)`, as a server that is down or erroring does. */
  answer(status: number | undefined): void;
  /** How many times the latest release was asked for. */
  asked(): number;
  /** Writes an `update.conf` for a host with this data root that names the feed; returns its path. */
  conf(dataRoot: string): string;
  stop(): void;
}

export function startFakeReleaseFeed(): FakeReleaseFeed {
  const root = mkdtempSync(join(tmpdir(), "release-feed-"));
  let latest: string | undefined;
  let forced: number | undefined;
  let asks = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === `/${FEED_REPO}/releases/latest/download/release.json`) {
        asks++;
        if (forced !== undefined) return new Response("unavailable", { status: forced });
        return latest === undefined
          ? new Response("no releases", { status: 404 })
          : new Response(null, {
              status: 302,
              headers: { location: `/${FEED_REPO}/releases/download/v${latest}/release.json` },
            });
      }
      try {
        return new Response(readFileSync(join(root, pathname)));
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    publish(version, shellApi = { min: 1, max: 1 }) {
      const dir = join(root, FEED_REPO, "releases", "download", `v${version}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "release.json"),
        JSON.stringify({ version, shellApi, schemaVersion: 7 } satisfies ReleaseManifest),
      );
      latest = version;
    },
    answer: (status) => {
      forced = status;
    },
    asked: () => asks,
    conf(dataRoot) {
      const path = join(root, "update.conf");
      writeFileSync(
        path,
        [
          `REPO=${FEED_REPO}`,
          `PUBLIC_KEY=${"A".repeat(43)}=`,
          `DATA_ROOT=${dataRoot}`,
          "SERVICE=tomte",
          "SERVICE_USER=tomte",
          "BIN=/usr/local/bin/tomte-host",
          "ENV_FILE=/etc/tomte/tomte.env",
          `RELEASE_BASE_URL=${url}`,
          "",
        ].join("\n"),
      );
      return path;
    },
    stop() {
      void server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
