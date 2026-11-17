import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseHostConfig } from "../platform/config.ts";
import { openDb } from "../platform/db.ts";
import { SECRETS_FILE } from "../platform/file-secrets.ts";
import { credentialSecretName } from "../platform/secrets.ts";
import { clientPost, pairDevice } from "../testing/paired-device.ts";
import { createHostServer } from "./index.ts";

const FAKE_CLAUDE = join(import.meta.dir, "../testing/fake-claude.ts");
const PASSWORD = "synthetic-vault-password-4c1e";

let root: string;
let dataRoot: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomte-remote-secrets-"));
  dataRoot = join(root, "data");
  keyFile = join(root, "secrets.key");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const start = () => {
  const { config } = parseHostConfig(
    ["--mode", "remote", "--data-root", dataRoot, "--secrets-key-file", keyFile],
    {},
    { platform: "linux", home: root },
  );
  return createHostServer({
    config,
    cli: { path: FAKE_CLAUDE, source: "CLAUDE_PATH", needsShell: false },
    db: openDb(dataRoot),
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

test("a credential password lands encrypted in secrets.enc, not in the database or any response", async () => {
  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const server = await start();
  try {
    const token = pairDevice(server);
    const added = await clientPost(server, token, "/api/credentials/add", {
      label: "Example",
      signInUrl: "https://example.com/login",
      username: "alice",
      password: PASSWORD,
    });
    expect(added.status).toBe(200);
    const entry = (await added.json()) as { id: string };
    const listed = await clientPost(server, token, "/api/credentials/list", {});
    const responses = JSON.stringify(entry) + (await listed.text());

    const file = readFileSync(join(dataRoot, SECRETS_FILE)).toString("latin1");
    expect(file).toContain(credentialSecretName(entry.id));
    expect(file).not.toContain(PASSWORD);
    expect(responses).not.toContain(PASSWORD);
    const db = openDb(dataRoot);
    expect(JSON.stringify(db.query("SELECT * FROM credential_entries").all())).not.toContain(
      PASSWORD,
    );
    db.close();
  } finally {
    await server.close();
  }
});

test("a host started with another key than the one that wrote secrets.enc refuses to start", async () => {
  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const first = await start();
  const token = pairDevice(first);
  const added = await clientPost(first, token, "/api/credentials/add", {
    label: "Example",
    signInUrl: "https://example.com/login",
    username: "alice",
    password: PASSWORD,
  });
  expect(added.status).toBe(200);
  await first.close();

  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  await expect(start()).rejects.toThrow(/cannot decrypt/);
});
