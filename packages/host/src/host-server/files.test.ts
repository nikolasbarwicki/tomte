import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botFilesPath } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let botId: string;
let files: string;
let outside: string;
let revealed: string[];

const REMOTE = ["--mode", "remote", "--secrets-key-file", "/unused/secrets.key"];

async function start(flags: string[] = []) {
  revealed = [];
  host = await startHandoffHost(flags, undefined, (path) => void revealed.push(path));
  botId = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  files = botFilesPath(host.dataRoot, botId);
  mkdirSync(files, { recursive: true });
  outside = mkdtempSync(join(tmpdir(), "files-outside-"));
}

afterEach(async () => {
  await host.stop();
  rmSync(outside, { recursive: true, force: true });
});

const download = (path: string, headers: Record<string, string> = host.authHeaders) =>
  fetch(`${host.clientUrl}/api/files/download?path=${encodeURIComponent(path)}`, { headers });

describe("downloading a file", () => {
  beforeEach(() => start());

  test("streams the bytes as an attachment", async () => {
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
    mkdirSync(join(files, "reports"));
    writeFileSync(join(files, "reports", "q3.bin"), bytes);

    const res = await download("reports/q3.bin");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="q3.bin"; filename*=UTF-8''q3.bin`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("serves an empty file", async () => {
    writeFileSync(join(files, "empty.txt"), "");
    const res = await download("empty.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
  });

  test("names a file with quotes, spaces and non-ASCII letters safely", async () => {
    const name = `Zażółć "gęślą" (1)'.txt`;
    writeFileSync(join(files, name), "x");

    const res = await download(name);

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename="Za____ _g__l__ (1)'.txt"`);
    expect(disposition).toContain(
      "filename*=UTF-8''Za%C5%BC%C3%B3%C5%82%C4%87%20%22g%C4%99%C5%9Bl%C4%85%22%20%281%29%27.txt",
    );
    expect(await res.text()).toBe("x");
  });

  test("needs a paired device", async () => {
    writeFileSync(join(files, "a.txt"), "secret");
    const res = await download("a.txt", {});
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("secret");
  });

  test("accepts the session cookie, as a plain link in the web page sends it", async () => {
    writeFileSync(join(files, "a.txt"), "hello");
    const res = await download("a.txt", { cookie: `claudebot_session=${host.deviceToken}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  describe("refuses with 404 and no bytes", () => {
    const refused = async (path: string) => {
      const res = await download(path);
      const body = await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(body).not.toContain("TOP-SECRET");
    };

    beforeEach(() => {
      writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
      writeFileSync(join(files, "..", "memory.md"), "TOP-SECRET");
      mkdirSync(join(files, "dir"));
      writeFileSync(join(files, "dir", "inner.txt"), "inner");
    });

    test("a path that climbs out with ..", async () => {
      await refused("../memory.md");
      await refused("dir/../../memory.md");
    });

    test("an absolute path", async () => {
      await refused(join(outside, "secret.txt"));
    });

    test("a symlinked file that points outside", async () => {
      symlinkSync(join(outside, "secret.txt"), join(files, "link.txt"));
      await refused("link.txt");
    });

    test("a file inside a symlinked directory that points outside", async () => {
      symlinkSync(outside, join(files, "linked-dir"));
      await refused("linked-dir/secret.txt");
    });

    test("a directory", async () => {
      await refused("dir");
    });

    test("a missing file, no path and the files directory itself", async () => {
      await refused("nope.txt");
      await refused("");
      await refused(".");
    });

    test("a symlink that stays inside is followed", async () => {
      symlinkSync(join(files, "dir", "inner.txt"), join(files, "alias.txt"));
      const res = await download("alias.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("inner");
    });
  });
});

describe("revealing in the file manager", () => {
  test("local mode reveals the confined path", async () => {
    await start();
    writeFileSync(join(files, "a.txt"), "x");

    expect((await host.ui("/api/files/reveal", { path: "a.txt" })).status).toBe(200);
    expect((await host.ui("/api/files/reveal", {})).status).toBe(200);
    expect((await host.ui("/api/files/reveal", { path: "../memory.md" })).status).toBe(404);

    expect(revealed).toEqual([join(files, "a.txt"), files]);
  });

  test("remote mode answers 404 and reveals nothing", async () => {
    await start(REMOTE);
    writeFileSync(join(files, "a.txt"), "x");

    expect((await host.ui("/api/files/reveal", { path: "a.txt" })).status).toBe(404);
    expect((await host.ui("/api/files/reveal", {})).status).toBe(404);

    expect(revealed).toEqual([]);
  });

  test("remote mode still downloads", async () => {
    await start(REMOTE);
    writeFileSync(join(files, "a.txt"), "x");
    expect(await (await download("a.txt")).text()).toBe("x");
  });
});
