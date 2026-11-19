import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONF_PATH,
  hostInfoUrl,
  InvalidUpdateConf,
  parseUpdateConf,
} from "../platform/update-conf.ts";
import { download, serviceUser, systemd, systemDeps } from "./system.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "update-system-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const CONF = [
  "# written by install.sh",
  "REPO=owner/tomte",
  `PUBLIC_KEY=${"A".repeat(43)}=`,
  "DATA_ROOT=/var/lib/tomte",
  "SERVICE=tomte",
  "SERVICE_USER=tomte",
  "BIN=/usr/local/bin/tomte-host",
  "ENV_FILE=/etc/tomte/tomte.env",
  "RELEASE_BASE_URL=https://github.com",
  "",
].join("\n");

describe("update.conf", () => {
  test("parses every setting and defaults the helper's state directory", () => {
    expect(parseUpdateConf(CONF)).toEqual({
      repo: "owner/tomte",
      publicKey: `${"A".repeat(43)}=`,
      dataRoot: "/var/lib/tomte",
      service: "tomte",
      serviceUser: "tomte",
      bin: "/usr/local/bin/tomte-host",
      envFile: "/etc/tomte/tomte.env",
      releaseBaseUrl: "https://github.com",
      stateDir: "/var/lib/tomte-update",
    });
    expect(DEFAULT_CONF_PATH).toBe("/etc/tomte/update.conf");
  });

  test.each([
    ["an unknown setting", `${CONF}EXTRA=1\n`, "unknown setting"],
    ["a repeated setting", `${CONF}REPO=a/b\n`, "set twice"],
    ["a missing setting", CONF.replace("REPO=owner/tomte\n", ""), "repo"],
    ["a malformed repository", CONF.replace("owner/tomte", "owner"), "repo"],
    ["a malformed key", CONF.replace(/PUBLIC_KEY=.*/, "PUBLIC_KEY=abc"), "publicKey"],
    ["a relative binary", CONF.replace("/usr/local/bin/tomte-host", "tomte-host"), "bin"],
    ["a unit name with a slash", CONF.replace("SERVICE=tomte", "SERVICE=a/b"), "service"],
  ])("%s is refused", (_name, text, message) => {
    expect(() => parseUpdateConf(text)).toThrow(InvalidUpdateConf);
    expect(() => parseUpdateConf(text)).toThrow(message);
  });
});

describe("hostInfoUrl", () => {
  test.each([
    ["", "http://127.0.0.1:8417/api/host-info"],
    ["TOMTE_HOST=10.0.0.5\nTOMTE_PORT=9000\n", "http://10.0.0.5:9000/api/host-info"],
    ["TOMTE_HOST=0.0.0.0\n", "http://127.0.0.1:8417/api/host-info"],
    ["TOMTE_HOST=::\nTOMTE_PORT=1\n", "http://[::1]:1/api/host-info"],
    ["TOMTE_HOST=fd00::1\n", "http://[fd00::1]:8417/api/host-info"],
    ["TOMTE_HOST=a\nTOMTE_HOST=b\n", "http://b:8417/api/host-info"],
  ])("%j", (env, url) => {
    expect(hostInfoUrl(env)).toBe(url);
  });
});

describe("systemd", () => {
  test("runs each verb on the unit and reads is-active from the exit code", async () => {
    const log = join(dir, "calls");
    const ctl = script(
      "systemctl",
      `echo "$@" >> ${log}\nif [ "$1" = is-active ]; then [ -e ${join(dir, "active")} ]; fi`,
    );
    const s = systemd("tomte", ctl);
    await s.stop();
    await s.start();
    await s.restart();
    expect(await s.isActive()).toBe(false);
    writeFileSync(join(dir, "active"), "");
    expect(await s.isActive()).toBe(true);
    expect(readFileSync(log, "utf8")).toBe(
      "stop tomte.service\nstart tomte.service\nrestart tomte.service\nis-active --quiet tomte.service\nis-active --quiet tomte.service\n",
    );
  });

  test("a failing verb throws with systemctl's own message", async () => {
    const s = systemd("tomte", script("systemctl", "echo 'Unit not found' >&2; exit 5"));
    await expect(s.restart()).rejects.toThrow("failed (exit 5): Unit not found");
  });
});

describe("the service user's files", () => {
  const user = serviceUser([]);

  test("writeFile replaces the file whole", async () => {
    const path = join(dir, "result.json");
    await user.writeFile(path, '{"a":1}');
    await user.writeFile(path, '{"b":2}');
    expect(readFileSync(path, "utf8")).toBe('{"b":2}');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("restoreDatabase replaces the database and removes the write-ahead files", async () => {
    const db = join(dir, "tomte.db");
    writeFileSync(db, "new");
    writeFileSync(`${db}-wal`, "wal");
    writeFileSync(join(dir, "snap.db"), "old");
    await user.restoreDatabase(join(dir, "snap.db"), [db, `${db}-wal`, `${db}-shm`]);
    expect(readFileSync(db, "utf8")).toBe("old");
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}.restore`)).toBe(false);
  });

  test("a missing snapshot leaves the database alone", async () => {
    const db = join(dir, "tomte.db");
    writeFileSync(db, "new");
    await expect(user.restoreDatabase(join(dir, "none.db"), [db])).rejects.toThrow();
    expect(readFileSync(db, "utf8")).toBe("new");
  });
});

describe("download", () => {
  test("writes the body to the file and throws the status on a failure", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/file"
          ? new Response("bytes")
          : new Response("no", { status: 404 }),
    });
    try {
      const dest = join(dir, "got");
      await download(`${server.url.href}file`, dest);
      expect(readFileSync(dest, "utf8")).toBe("bytes");
      await expect(download(`${server.url.href}other`, dest)).rejects.toThrow("404");
    } finally {
      await server.stop(true);
    }
  });
});

describe("systemDeps", () => {
  const conf = () => parseUpdateConf(CONF.replace("/etc/tomte/tomte.env", join(dir, "tomte.env")));

  test("picks the release binary for the CPU and refuses a platform with none", () => {
    expect(systemDeps(conf(), "linux-arm64").asset).toBe("tomte-host-linux-arm64");
    expect(systemDeps(conf(), "linux-x64").asset).toBe("tomte-host-linux-x64");
    expect(() => systemDeps(conf(), "darwin-arm64")).toThrow("no release binary for darwin-arm64");
  });

  test("versionOf parses what `version` prints and rejects anything else", async () => {
    const deps = systemDeps(conf(), "linux-x64");
    const good = script("good", `echo '{"version":"1.2.3","schemaVersion":9}'`);
    expect(await deps.versionOf(good)).toEqual({ version: "1.2.3", schemaVersion: 9 });
    await expect(deps.versionOf(script("bad", "echo nope"))).rejects.toThrow();
    await expect(deps.versionOf(script("fails", "exit 3"))).rejects.toThrow("exit 3");
  });

  test("hostVersion reads the version host-info reports on the configured address", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ version: "0.4.2", extra: 1 }),
    });
    try {
      writeFileSync(join(dir, "tomte.env"), `TOMTE_HOST=127.0.0.1\nTOMTE_PORT=${server.port}\n`);
      expect(await systemDeps(conf(), "linux-x64").hostVersion()).toBe("0.4.2");
    } finally {
      await server.stop(true);
    }
  });

  test("the clock and the log are the process's", async () => {
    const deps = systemDeps(conf(), "linux-x64");
    expect(Math.abs(deps.now() - Date.now())).toBeLessThan(1000);
    await deps.sleep(1);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    deps.log("nothing to see");
    expect(errors).toHaveBeenCalledWith("apply-update: nothing to see");
    errors.mockRestore();
  });
});
