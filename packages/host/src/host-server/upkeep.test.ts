import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFakeReleaseFeed, type FakeReleaseFeed } from "../testing/fake-release-feed.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

setDefaultTimeout(60_000);

let host: HandoffHost | undefined;
let watcher: EventsWatch | undefined;
let feed: FakeReleaseFeed | undefined;
let dataRoot: string | undefined;

afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await host?.stop();
  host = undefined;
  feed?.stop();
  feed = undefined;
  if (dataRoot !== undefined) rmSync(dataRoot, { recursive: true, force: true });
});

const REMOTE = ["--mode", "remote", "--secrets-key-file", "/etc/tomte-test/secrets.key"];

test("a server with the update helper tells every page what the release feed says, as it changes", async () => {
  feed = startFakeReleaseFeed();
  feed.publish("0.1.0");
  // The helper's configuration names the data root, so the host is given one.
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "upkeep-host-")));
  host = await startHandoffHost([...REMOTE, "--data-root", dataRoot], undefined, undefined, {
    upkeep: { confPath: feed.conf(dataRoot), checkEveryMs: 50 },
  });
  watcher = await watchEvents(host);
  const update = () => watcher!.hostStatus()?.update;

  await host.until(() => update()?.status === "current");
  feed.publish("0.2.0");
  await host.until(() => update()?.status === "available");
  expect(update()).toEqual({
    status: "available",
    version: "0.2.0",
    notesUrl: `${feed.url}/owner/tomte/releases/tag/v0.2.0`,
    raisesShellApi: false,
  });

  feed.answer(503);
  await Bun.sleep(200);
  expect(update()?.status).toBe("available");
});
