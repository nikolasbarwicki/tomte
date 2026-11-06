import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installManagedCli, resolveCli } from "./cli.ts";

const envKeys = ["CLAUDE_PATH", "PATH"] as const;
const realFetch = globalThis.fetch;

describe("managed Claude CLI", () => {
  let dir: string;
  let dataRoot: string;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  /** A gzipped tarball holding `package/<name>`, built with the system tar the installer itself uses. */
  const tarball = (name: string) => {
    const src = join(dir, "src");
    mkdirSync(join(src, "package"), { recursive: true });
    writeFileSync(join(src, "package", name), "#!/bin/sh\n");
    const file = join(dir, "pkg.tgz");
    expect(spawnSync("tar", ["-czf", file, "-C", src, "package"]).status).toBe(0);
    return readFileSync(file);
  };

  /** Serves the registry metadata and the tarball without any network. */
  const serve = (
    bytes: Buffer,
    integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  ) => {
    globalThis.fetch = (async (url: string) =>
      String(url).startsWith("https://registry.npmjs.org/")
        ? Response.json({
            version: "9.9.9",
            dist: { tarball: "https://registry.test/claude.tgz", integrity },
          })
        : new Response(bytes)) as unknown as typeof fetch;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-"));
    dataRoot = join(dir, "data");
    delete process.env.CLAUDE_PATH;
    // Only tar is on PATH, so no claude binary can be found there.
    mkdirSync(join(dir, "tools"));
    symlinkSync(Bun.which("tar")!, join(dir, "tools", "tar"));
    process.env.PATH = join(dir, "tools");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of envKeys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  });

  test("installs into the data root and resolves from it, and from no other data root", async () => {
    serve(tarball(process.platform === "win32" ? "claude.exe" : "claude"));
    expect(resolveCli(dataRoot)).toBeUndefined();

    const bin = await installManagedCli(dataRoot);

    expect(bin.startsWith(join(dataRoot, "claude-cli", "9.9.9"))).toBe(true);
    expect(resolveCli(dataRoot)).toMatchObject({ path: bin, source: "managed" });
    expect(resolveCli(join(dir, "elsewhere"))).toBeUndefined();
  });

  test("an integrity mismatch installs nothing", async () => {
    serve(tarball("claude"), "sha512-AAAA");
    await expect(installManagedCli(dataRoot)).rejects.toThrow("integrity mismatch");
    expect(existsSync(dataRoot)).toBe(false);
    expect(resolveCli(dataRoot)).toBeUndefined();
  });
});
