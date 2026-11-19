import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

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
    const res = await download("a.txt", { cookie: `tomte_session=${host.deviceToken}` });
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

    test("a missing file", async () => {
      await refused("nope.txt");
    });

    test("a symlink that stays inside is followed", async () => {
      symlinkSync(join(files, "dir", "inner.txt"), join(files, "alias.txt"));
      const res = await download("alias.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("inner");
    });
  });
});

const unzip = (...args: string[]) => {
  const run = Bun.spawnSync(["unzip", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
};

/** Every file and folder under `root` as `path` (folders end in "/"), sorted. */
const tree = (root: string, rel = ""): string[] =>
  readdirSync(join(root, rel), { withFileTypes: true })
    .flatMap((e) => {
      const path = join(rel, e.name);
      return e.isDirectory() ? [`${path}/`, ...tree(root, path)] : [path];
    })
    .sort();

const ZEROS = Buffer.alloc(16 << 20);

describe("downloading a folder as a zip", () => {
  let scratch: string;

  /**
   * Saves the response body to a file and returns its path; the zip is read from disk, as a user's unzip would. A run
   * of zero bytes is left as a hole, so the 4 GiB member below costs the headers and not 4 GiB of disk.
   */
  const save = async (res: Response) => {
    const file = join(scratch, "download.zip");
    const fd = openSync(file, "w");
    try {
      let position = 0;
      for await (const chunk of res.body!) {
        if (
          !Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).equals(
            ZEROS.subarray(0, chunk.length),
          )
        )
          writeSync(fd, chunk, 0, chunk.length, position);
        position += chunk.length;
      }
      ftruncateSync(fd, position);
    } finally {
      closeSync(fd);
    }
    return file;
  };

  beforeEach(async () => {
    await start();
    scratch = mkdtempSync(join(tmpdir(), "files-zip-"));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  test("round-trips nested files, an empty file and an empty folder through a standard unzip", async () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);
    mkdirSync(join(files, "reports", "2026"), { recursive: true });
    mkdirSync(join(files, "drafts", "empty"), { recursive: true });
    writeFileSync(join(files, "reports", "2026", "q3.bin"), big);
    writeFileSync(join(files, "reports", "summary.txt"), "Zażółć gęślą jaźń");
    writeFileSync(join(files, "reports", "blank.txt"), "");
    writeFileSync(join(files, "top.md"), "top");

    const res = await download("");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Ada.zip"; filename*=UTF-8''Ada.zip`,
    );
    const zip = await save(res);
    expect(unzip("-tq", zip)).toMatchObject({ code: 0 });
    const out = join(scratch, "out");
    expect(unzip("-q", zip, "-d", out)).toMatchObject({ code: 0 });
    expect(tree(join(out, "Ada"))).toEqual([
      "drafts/",
      "drafts/empty/",
      "reports/",
      "reports/2026/",
      "reports/2026/q3.bin",
      "reports/blank.txt",
      "reports/summary.txt",
      "top.md",
    ]);
    expect(new Uint8Array(readFileSync(join(out, "Ada", "reports", "2026", "q3.bin")))).toEqual(
      big,
    );
    expect(readFileSync(join(out, "Ada", "reports", "summary.txt"), "utf8")).toBe(
      "Zażółć gęślą jaźń",
    );
    expect(statSync(join(out, "Ada", "reports", "blank.txt")).size).toBe(0);
  });

  test("an empty files folder is a zip of one empty folder", async () => {
    const zip = await save(await download(""));
    const out = join(scratch, "out");
    expect(unzip("-q", zip, "-d", out)).toMatchObject({ code: 0 });
    expect(tree(out)).toEqual(["Ada/"]);
  });

  test("a subfolder unpacks under its own name", async () => {
    mkdirSync(join(files, "reports", "2026"), { recursive: true });
    writeFileSync(join(files, "reports", "2026", "q3.txt"), "q3");
    writeFileSync(join(files, "reports", "top.txt"), "top");
    writeFileSync(join(files, "other.txt"), "other");

    const res = await download("reports");

    expect(res.headers.get("content-disposition")).toContain(`filename="reports.zip"`);
    const out = join(scratch, "out");
    expect(unzip("-q", await save(res), "-d", out)).toMatchObject({ code: 0 });
    expect(tree(out)).toEqual([
      "reports/",
      "reports/2026/",
      "reports/2026/q3.txt",
      "reports/top.txt",
    ]);
  });

  test("the whole folder leaves out the browser's scratch folder, links and .DS_Store", async () => {
    mkdirSync(join(files, "browser"));
    writeFileSync(join(files, "browser", "shot.png"), "scratch");
    writeFileSync(join(files, "kept.txt"), "kept");
    writeFileSync(join(files, ".DS_Store"), "junk");
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
    symlinkSync(join(outside, "secret.txt"), join(files, "link.txt"));
    symlinkSync(outside, join(files, "linked-dir"));

    const out = join(scratch, "out");
    expect(unzip("-q", await save(await download("")), "-d", out)).toMatchObject({ code: 0 });

    expect(tree(out)).toEqual(["Ada/", "Ada/kept.txt"]);
  });

  test("names the folder after a bot whose name a file system would refuse", async () => {
    const id = host.createBot('R/D: "x"');
    await host.ui("/api/open", { botId: id });
    const res = await download("");
    expect(res.headers.get("content-disposition")).toContain(`filename="R-D- -x-.zip"`);
  });

  test("refuses a folder outside the files folder", async () => {
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
    symlinkSync(outside, join(files, "linked-dir"));
    for (const path of ["..", "../..", outside, "linked-dir", "nope"]) {
      const res = await download(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("TOP-SECRET");
    }
  });

  test("needs a paired device", async () => {
    expect((await download("", {})).status).toBe(401);
  });

  test("a file over 4 GiB and the member after it are one valid ZIP64 archive", async () => {
    const size = 2 ** 32 + 1;
    writeFileSync(join(files, "a-big.bin"), "");
    truncateSync(join(files, "a-big.bin"), size);
    writeFileSync(join(files, "b-after.txt"), "after the 4 GiB mark");

    const zip = await save(await download(""));

    // unzip reads the central directory, so a wrong 64-bit size, checksum or offset shows here; checking the big member's
    // bytes would take it minutes, so only the member after it, which sits past 4 GiB, is extracted.
    let crc = 0;
    for (let left = size; left > 0; left -= ZEROS.length)
      crc = crc32(ZEROS.subarray(0, Math.min(left, ZEROS.length)), crc);
    const listing = unzip("-v", zip).out.split("\n");
    const big = listing.find((l) => l.endsWith("Ada/a-big.bin")) ?? "";
    expect(big).toContain(`${size}`);
    expect(big).toContain(crc.toString(16).padStart(8, "0"));
    expect(unzip("-tq", zip, "Ada/b-after.txt")).toMatchObject({ code: 0 });
    expect(unzip("-p", zip, "Ada/b-after.txt").out).toBe("after the 4 GiB mark");
    expect(statSync(zip).size).toBeGreaterThan(size);
  }, 300_000);
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
