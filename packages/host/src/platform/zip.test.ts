import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zip, type ZipEntry } from "./zip.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "zip-test-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function write(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): Promise<string> {
  const file = join(scratch, "out.zip");
  const parts: Uint8Array[] = [];
  for await (const chunk of zip(entries)) parts.push(chunk);
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

const unzip = (...args: string[]) => {
  const run = Bun.spawnSync(["unzip", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString() };
};

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("a zip written from entries", () => {
  test("keeps a file's bytes across chunks and checks out under a standard unzip", async () => {
    const file = await write([
      { name: "r/", mtime: Date.now() },
      { name: "r/a.txt", mtime: Date.now(), data: chunks("hel", "lo ", "world") },
      { name: "r/ü ß.txt", mtime: Date.now(), data: [new TextEncoder().encode("utf-8 name")] },
    ]);

    expect(unzip("-tq", file).code).toBe(0);
    expect(unzip("-p", file, "r/a.txt").out).toBe("hello world");
    expect(unzip("-p", file, "r/ü ß.txt").out).toBe("utf-8 name");
  });

  test("holds a date before 1980, which the format cannot, as 1980", async () => {
    const file = await write([{ name: "old.txt", mtime: 0, data: chunks("x") }]);
    expect(unzip("-l", file).out).toContain("1980");
  });

  test("lists more members than a 16-bit count holds", async () => {
    const count = 70_000;
    function* folders(): Generator<ZipEntry> {
      for (let i = 0; i < count; i++) yield { name: `d${i}/`, mtime: Date.now() };
    }
    const file = await write(folders());
    expect(unzip("-l", file).out).toContain(`${count} files`);
  });

  test("an empty archive is just the end record", async () => {
    const file = await write([]);
    expect(statSync(file).size).toBe(56 + 20 + 22);
  });

  test("refuses a name no zip can hold", async () => {
    await expect(write([{ name: "x".repeat(70_000), mtime: 0 }])).rejects.toThrow("too long");
  });

  test("a failing source fails the stream instead of ending a short archive", async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("disk went away");
    }
    await expect(write([{ name: "a.txt", mtime: 0, data: broken() }])).rejects.toThrow(
      "disk went away",
    );
  });
});
