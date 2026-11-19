import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UploadResponse } from "@tomte/contract/api";

import { botFilesPath } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { uploadFile } from "../testing/upload-file.ts";

let host: HandoffHost | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A host with one open bot; returns its files folder. */
async function start(...flags: string[]) {
  host = await startHandoffHost(flags);
  const botId = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  return botFilesPath(host.dataRoot, botId);
}

const up = (
  path: string,
  body: Parameters<typeof uploadFile>[2],
  options?: Parameters<typeof uploadFile>[3],
) => uploadFile(host!, path, body, options);

const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

/** Whether two files hold the same bytes, read a chunk at a time. */
function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  const [fa, fb] = [openSync(a, "r"), openSync(b, "r")];
  const [ba, bb] = [Buffer.alloc(4 * 2 ** 20), Buffer.alloc(4 * 2 ** 20)];
  try {
    for (;;) {
      const n = readSync(fa, ba);
      readSync(fb, bb);
      if (n === 0) return true;
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false;
    }
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
}

describe("a streamed upload", () => {
  test("round-trips a 200 MB file byte for byte", async () => {
    const files = await start();
    scratch = mkdtempSync(join(tmpdir(), "upload-"));
    const source = join(scratch, "source.bin");
    const chunk = Buffer.alloc(2 ** 20);
    const fd = openSync(source, "w");
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < chunk.length; j += 4093) chunk[j] = (i * 31 + j) % 256;
      writeSync(fd, chunk);
    }
    closeSync(fd);

    const res = await up("big/data.bin", Bun.file(source));
    expect(await answer(res)).toEqual({ status: 200, body: { path: "big/data.bin" } });
    expect(sameBytes(source, join(files, "big", "data.bin"))).toBe(true);
  }, 60_000);

  test("lands at a path under the files folder with its folders, and a taken name is renamed and says from what", async () => {
    const files = await start();
    expect(await answer(await up("notes/2026/june.md", "J"))).toEqual({
      status: 200,
      body: { path: "notes/2026/june.md" },
    });
    expect(await answer(await up("notes/2026/june.md", "again"))).toEqual({
      status: 200,
      body: { path: "notes/2026/june 2.md", renamedFrom: "notes/2026/june.md" },
    });
    expect(await answer(await up("notes/2026/june.md", "third"))).toMatchObject({
      body: { path: "notes/2026/june 3.md" },
    });
    expect(readFileSync(join(files, "notes", "2026", "june.md"), "utf8")).toBe("J");
    expect(readFileSync(join(files, "notes", "2026", "june 2.md"), "utf8")).toBe("again");
  });

  test("an empty file is saved", async () => {
    const files = await start();
    expect((await up("empty.txt", "")).status).toBe(200);
    expect(statSync(join(files, "empty.txt")).size).toBe(0);
  });

  test("with a folder, a taken folder is renamed once and its files follow into the new one", async () => {
    const files = await start();
    expect(
      await answer(await up("attachments/notes/a.md", "A", { folder: "attachments/notes" })),
    ).toEqual({
      status: 200,
      body: { path: "attachments/notes/a.md" },
    });
    const second = (await (
      await up("attachments/notes/a.md", "B", { folder: "attachments/notes" })
    ).json()) as UploadResponse;
    expect(second).toEqual({
      path: "attachments/notes 2/a.md",
      renamedFrom: "attachments/notes/a.md",
    });
    expect((await up("attachments/notes 2/sub/b.md", "C")).status).toBe(200);
    expect(readdirSync(join(files, "attachments", "notes"))).toEqual(["a.md"]);
    expect(readFileSync(join(files, "attachments", "notes 2", "sub", "b.md"), "utf8")).toBe("C");
  });

  test("a folder that is not a leading part of the path is refused", async () => {
    const files = await start();
    for (const folder of ["other", "a/b/c.txt", "a/b/c.txt/d"]) {
      expect((await up("a/b/c.txt", "x", { folder })).status).toBe(400);
    }
    expect(existsSync(join(files, "a"))).toBe(false);
  });

  test("a path that escapes the files folder is refused and writes nothing", async () => {
    const files = await start();
    for (const path of [
      "../evil.txt",
      "notes/../../evil.txt",
      "notes/./x.txt",
      "/etc/evil.txt",
      "a//b.txt",
      "a\\..\\evil.txt",
      "a/b/",
      "x\0y",
      "",
    ]) {
      expect((await up(path, "x")).status).toBe(400);
    }
    expect((await up("a".repeat(300), "x")).status).toBe(400);
    expect(existsSync(join(files, "..", "evil.txt"))).toBe(false);
    expect(existsSync(join(files, "evil.txt"))).toBe(false);
    expect(readdirSync(files)).toEqual([]);
  });

  test("a symlink on the way out of the files folder is refused, and one in place of the file is never written through", async () => {
    const files = await start();
    scratch = mkdtempSync(join(tmpdir(), "upload-outside-"));
    mkdirSync(files, { recursive: true });
    symlinkSync(scratch, join(files, "docs"));
    writeFileSync(join(scratch, "victim.txt"), "keep");
    symlinkSync(join(scratch, "victim.txt"), join(files, "report.txt"));

    expect((await up("docs/x.txt", "x")).status).toBe(400);
    expect((await up("docs/deeper/x.txt", "x")).status).toBe(400);
    expect(await answer(await up("report.txt", "new"))).toEqual({
      status: 200,
      body: { path: "report 2.txt", renamedFrom: "report.txt" },
    });
    expect(readdirSync(scratch)).toEqual(["victim.txt"]);
    expect(readFileSync(join(scratch, "victim.txt"), "utf8")).toBe("keep");
  });

  test("a file in the way of a folder is refused", async () => {
    const files = await start();
    writeFileSync(join(files, "notes"), "a file");
    expect((await up("notes/a.md", "x")).status).toBe(400);
    expect(readFileSync(join(files, "notes"), "utf8")).toBe("a file");
  });

  test("a request that is not a byte stream or names no open bot is refused", async () => {
    const files = await start();
    expect((await up("a.txt", "{}", { contentType: "application/json" })).status).toBe(415);
    expect((await up("a.txt", "x", { contentType: "text/plain" })).status).toBe(415);
    const noOrigin = await fetch(`${host!.clientUrl}/api/files/upload?path=a.txt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...host!.authHeaders },
      body: "x",
    });
    expect(noOrigin.status).toBe(403);
    const unpaired = await fetch(`${host!.clientUrl}/api/files/upload?path=a.txt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: host!.clientUrl },
      body: "x",
    });
    expect(unpaired.status).toBe(401);
    expect(readdirSync(files)).toEqual([]);
  });

  test("the base64 attach route is gone", async () => {
    await start();
    expect(
      (await host!.ui("/api/files/attach", { files: [{ path: "a.txt", data: "eA==" }] })).status,
    ).toBe(404);
  });
});

describe("the per-file cap", () => {
  test("is 1 GiB until configured, and the host's info reports it", async () => {
    await start();
    const info = (await (await host!.ui("/api/info", {})).json()) as { maxUploadBytes: number };
    expect(info.maxUploadBytes).toBe(2 ** 30);
  });

  test("a file declared over the cap is refused naming the cap, a file at it is saved, the cap is per file", async () => {
    const files = await start("--max-upload-mib", "1");
    expect(
      (await host!.ui("/api/info", {}).then((r) => r.json())) as { maxUploadBytes: number },
    ).toMatchObject({ maxUploadBytes: 2 ** 20 });

    const over = await answer(await up("big.bin", new Uint8Array(2 ** 20 + 1)));
    expect(over).toEqual({
      status: 413,
      body: { error: "big.bin is over the upload limit of 1 MiB per file" },
    });
    expect(existsSync(join(files, "big.bin"))).toBe(false);

    expect((await up("exact.bin", new Uint8Array(2 ** 20))).status).toBe(200);
    expect((await up("second.bin", new Uint8Array(2 ** 20))).status).toBe(200);
    expect(statSync(join(files, "exact.bin")).size).toBe(2 ** 20);
  });

  test("a stream that goes over the cap without declaring a length is refused and leaves no partial file", async () => {
    const files = await start("--max-upload-mib", "1");
    const piece = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(piece);
        else controller.close();
      },
    });
    const res = await up("stream.bin", body).catch(() => undefined);
    // The host closes the connection once it answers, so a client may see a reset instead of the 413.
    if (res) expect(res.status).toBe(413);
    await host!.until(() => !existsSync(join(files, "stream.bin")));
    expect(readdirSync(files)).toEqual([]);
  });
});
