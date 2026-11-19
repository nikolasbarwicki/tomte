// deploy/install.sh's update-helper output (the root-owned update.conf and the two units), sourced the way the tests of the
// verified download are, against a copy that pins a throwaway key. The conf must parse with the helper's own parser.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseUpdateConf } from "../packages/host/src/platform/update-conf.ts";
import { generateTestKey } from "./release-test-kit.ts";

const INSTALLER = join(import.meta.dir, "../deploy/install.sh");

let root: string;
let script: string;
const key = generateTestKey();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "install-update-helper-"));
  script = join(root, "install.sh");
  const original = await readFile(INSTALLER, "utf8");
  await writeFile(
    script,
    original.replace(/^RELEASE_PUBLIC_KEY=".*"$/m, `RELEASE_PUBLIC_KEY="${key.publicKey}"`),
  );
});
afterEach(() => rm(root, { recursive: true, force: true }));

const sourced = (body: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", "-c", `source "${script}"; ${body}`], {
    env: { PATH: process.env.PATH!, ...env },
  });

describe("write_update_conf", () => {
  test("writes the pinned key and the installer's own paths, in a form the helper parses", async () => {
    const out = join(root, "update.conf");
    const r = sourced(`write_update_conf "${out}" owner/tomte`);
    expect(r.exitCode).toBe(0);
    expect(parseUpdateConf(await readFile(out, "utf8"))).toEqual({
      repo: "owner/tomte",
      publicKey: key.publicKey,
      dataRoot: "/var/lib/tomte",
      service: "tomte",
      serviceUser: "tomte",
      bin: "/usr/local/bin/tomte-host",
      envFile: "/etc/tomte/tomte.env",
      releaseBaseUrl: "https://github.com",
      stateDir: "/var/lib/tomte-update",
    });
  });

  test("the key is the script's constant, whatever the environment says", async () => {
    const out = join(root, "update.conf");
    const other = generateTestKey().publicKey;
    sourced(`write_update_conf "${out}" owner/tomte`, {
      RELEASE_PUBLIC_KEY: other,
      TOMTE_PUBLIC_KEY: other,
    });
    expect(parseUpdateConf(await readFile(out, "utf8")).publicKey).toBe(key.publicKey);
  });

  test("follows the release base URL seam and trims its trailing slash", async () => {
    const out = join(root, "update.conf");
    sourced(`write_update_conf "${out}" owner/tomte`, {
      TOMTE_RELEASE_BASE_URL: "https://ghe.example.com/",
    });
    expect(parseUpdateConf(await readFile(out, "utf8")).releaseBaseUrl).toBe(
      "https://ghe.example.com",
    );
  });

  test("refuses to write a conf while the key is unpinned", async () => {
    await writeFile(
      script,
      (await readFile(INSTALLER, "utf8")).replace(
        /^RELEASE_PUBLIC_KEY=".*"$/m,
        'RELEASE_PUBLIC_KEY=""',
      ),
    );
    const r = sourced(`write_update_conf "${join(root, "update.conf")}" owner/tomte`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("pins no release public key");
  });
});

describe("write_update_units", () => {
  const units = async () => {
    expect(sourced(`write_update_units "${root}"`).exitCode).toBe(0);
    return {
      service: await readFile(join(root, "tomte-update.service"), "utf8"),
      path: await readFile(join(root, "tomte-update.path"), "utf8"),
    };
  };

  test("the service runs apply-update as root, once per start, with the installed binary", async () => {
    const { service } = await units();
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/tomte-host apply-update\n");
    expect(service).not.toMatch(/^(User|Group)=/m);
    expect(service).toContain("ReadWritePaths=/usr/local/bin /var/lib/tomte\n");
    expect(service).toContain("StateDirectory=tomte-update\n");
  });

  test("the path unit starts it when the service user's request exists", async () => {
    const { path } = await units();
    expect(path).toContain("PathExists=/var/lib/tomte/updates/request.json\n");
    expect(path).toContain("Unit=tomte-update.service\n");
    expect(path).toContain("WantedBy=multi-user.target");
  });
});
