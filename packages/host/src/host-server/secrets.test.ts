import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseHostConfig } from "../platform/config.ts";
import { openDb } from "../platform/db.ts";
import { openFileSecrets, openSecrets } from "../platform/file-secrets.ts";
import { createHostServer } from "./index.ts";

const FAKE_CLAUDE = join(import.meta.dir, "../testing/fake-claude.ts");

let root: string;
let dataRoot: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomte-remote-secrets-"));
  dataRoot = join(root, "data");
  keyFile = join(root, "secrets.key");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const start = async () => {
  const { config } = parseHostConfig(
    ["--mode", "remote", "--data-root", dataRoot, "--secrets-key-file", keyFile],
    {},
    { platform: "linux", home: root },
  );
  const secrets = openSecrets(config);
  return createHostServer({
    config,
    cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
    db: await openDb(dataRoot, secrets),
    secrets,
    sandbox: () => ({ status: "available" }),
  });
};

test("remote mode refuses to start when the secrets key file is missing", async () => {
  const error = await start().then(
    () => undefined,
    (e: Error) => e,
  );
  expect(error?.message).toContain(keyFile);
  expect(error?.message).toContain("head -c 32 /dev/urandom");
});

test("remote mode refuses to start when the secrets key file is not 32 bytes", async () => {
  writeFileSync(keyFile, new Uint8Array(31));
  await expect(start()).rejects.toThrow(/exactly 32 raw bytes/);
});

test("a host started with another key than the one that wrote secrets.enc refuses to start", async () => {
  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await (await start()).close();
  await openFileSecrets(dataRoot, keyFile).set("integration:x", "synthetic-value");

  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await expect(start()).rejects.toThrow(/cannot decrypt/);
});
