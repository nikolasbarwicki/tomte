import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { World } from "../testing/update-world.ts";
import { applyUpdate, NotRoot, readUpdateConf } from "./index.ts";

let w: World;
let confPath: string;
beforeEach(() => {
  w = new World();
  w.install("0.1.0");
  confPath = join(w.root, "update.conf");
  const c = w.conf;
  writeFileSync(
    confPath,
    [
      `REPO=${c.repo}`,
      `PUBLIC_KEY=${c.publicKey}`,
      `DATA_ROOT=${c.dataRoot}`,
      `SERVICE=${c.service}`,
      `SERVICE_USER=${c.serviceUser}`,
      `BIN=${c.bin}`,
      `ENV_FILE=${c.envFile}`,
      `RELEASE_BASE_URL=${c.releaseBaseUrl}`,
      `STATE_DIR=${c.stateDir}`,
      "",
    ].join("\n"),
  );
  chmodSync(confPath, 0o644);
});
afterEach(() => w.dispose());

describe("applyUpdate", () => {
  test("refuses to run as the service user, before it reads anything", async () => {
    w.publish({ version: "0.2.0" });
    w.request({ kind: "apply", id: "r1", version: "0.2.0" });
    await expect(
      applyUpdate({ uid: 1001, confPath: "/does/not/exist", deps: () => w.deps() }),
    ).rejects.toThrow("runs as root only");
    expect(w.installed().version).toBe("0.1.0");
    expect(w.calls).toEqual([]);
  });

  test("as root with a root-owned config, handles the request", async () => {
    w.publish({ version: "0.2.0" });
    w.request({ kind: "apply", id: "r1", version: "0.2.0" });
    const me = process.getuid!();
    await applyUpdate({ uid: me, rootUid: me, confPath, deps: () => w.deps() });
    expect(w.result()).toMatchObject({ outcome: "updated", version: "0.2.0" });
  });

  test("a configuration someone else owns stops it before the request is read", async () => {
    w.request({ kind: "apply", id: "r1", version: "0.2.0" });
    const me = process.getuid!();
    await expect(
      applyUpdate({ uid: me, rootUid: me + 1, confPath, deps: () => w.deps() }),
    ).rejects.toThrow("runs as root only");
    expect(w.result()).toBeUndefined();
  });
});

describe("readUpdateConf", () => {
  const uid = () => process.getuid!();

  test("reads a file owned by the expected user that no one else can write", () => {
    expect(readUpdateConf(confPath, uid()).repo).toBe("owner/tomte");
  });

  test("refuses a file another user owns, one others can write, and a link", () => {
    expect(() => readUpdateConf(confPath, uid() + 1)).toThrow(NotRoot);
    chmodSync(confPath, 0o664);
    expect(() => readUpdateConf(confPath, uid())).toThrow("no one else can write");
    chmodSync(confPath, 0o646);
    expect(() => readUpdateConf(confPath, uid())).toThrow("no one else can write");
    chmodSync(confPath, 0o644);
    expect(() => readUpdateConf(w.root, uid())).toThrow(NotRoot);
  });
});
