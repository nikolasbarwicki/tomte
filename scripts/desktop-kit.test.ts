import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bundleDirName,
  bundledAppPath,
  bundledHostPath,
  collectDesktopRelease,
  desktopAssets,
  hostBinaryName,
  inCi,
  releaseAssets,
  updateProvider,
} from "./desktop-kit.ts";
import { HOST_BINARIES } from "./release-kit.ts";

describe("what a release holds", () => {
  test("every host binary, and per supported OS its installers and metadata", () => {
    const assets = releaseAssets("1.2.0");
    expect(assets).toEqual([
      ...HOST_BINARIES,
      "Claudebot-1.2.0-arm64.dmg",
      "Claudebot-1.2.0-arm64-mac.zip",
      "Claudebot-1.2.0.dmg",
      "Claudebot-1.2.0-mac.zip",
      "latest-mac.yml",
      "Claudebot-Setup-1.2.0.exe",
      "latest.yml",
      "Claudebot-1.2.0.AppImage",
      "Claudebot-1.2.0.deb",
      "latest-linux.yml",
    ]);
    expect(new Set(assets).size).toBe(assets.length);
  });

  test("a pre-release suffix is part of every name", () => {
    expect(desktopAssets("win32", ["x64"], "1.2.0-rc.1").installers).toEqual([
      "Claudebot-Setup-1.2.0-rc.1.exe",
    ]);
  });

  test("refuses an installer for a CPU the release does not ship", () => {
    expect(() => desktopAssets("linux", ["arm64"], "1.0.0")).toThrow("supported: x64");
    expect(() => desktopAssets("win32", ["arm64"], "1.0.0")).toThrow("no win32 installer");
  });

  test("host binaries and unpacked apps follow the build and electron-builder naming", () => {
    expect(hostBinaryName("win32", "x64")).toBe("claudebot-host-windows-x64.exe");
    expect(hostBinaryName("darwin", "arm64")).toBe("claudebot-host-darwin-arm64");
    expect(bundleDirName("darwin", ["arm64", "x64"])).toBe("Claudebot-darwin-arm64-x64");
    expect(bundledHostPath("darwin", "x64")).toBe(
      "mac/Claudebot.app/Contents/Resources/claudebot-host",
    );
    expect(bundledHostPath("darwin", "arm64")).toStartWith("mac-arm64/");
    expect(bundledHostPath("win32", "x64")).toBe("win-unpacked/resources/claudebot-host.exe");
    expect(bundledHostPath("linux", "arm64")).toBe("linux-arm64-unpacked/resources/claudebot-host");
    expect(bundledAppPath("darwin", "arm64")).toBe("mac-arm64/Claudebot.app");
    expect(bundledAppPath("win32", "x64")).toBe("win-unpacked/Claudebot.exe");
  });
});

describe("updateProvider", () => {
  test("a repository gives the GitHub provider", () => {
    expect(updateProvider("acme/claudebot", true)).toEqual({
      provider: "github",
      owner: "acme",
      repo: "claudebot",
    });
  });

  test("no repository: a local build gets the placeholder, a CI build fails", () => {
    expect(updateProvider(undefined, false).provider).toBe("generic");
    expect(() => updateProvider(undefined, true)).toThrow("GITHUB_REPOSITORY");
    expect(() => updateProvider("", true)).toThrow("GITHUB_REPOSITORY");
  });

  test("refuses a value that is not owner/repo", () => {
    expect(() => updateProvider("acme", false)).toThrow("not owner/repo");
    expect(() => updateProvider("a/b/c", false)).toThrow("not owner/repo");
  });

  test("CI is whatever the runner sets, except false and 0", () => {
    expect(inCi({ CI: "true" })).toBe(true);
    expect(inCi({ CI: "1" })).toBe(true);
    expect(inCi({})).toBe(false);
    expect(inCi({ CI: "" })).toBe(false);
    expect(inCi({ CI: "false" })).toBe(false);
    expect(inCi({ CI: "0" })).toBe(false);
  });
});

describe("collectDesktopRelease", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A Linux packaging run and the host directory it was built from. */
  async function linuxRun(opts: { bundledHost?: string; version?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), "desktop-kit-"));
    dirs.push(root);
    const bundleDir = join(root, "bundle");
    const hostDir = join(root, "hosts");
    const outDir = join(root, "out");
    await mkdir(hostDir);
    await writeFile(join(hostDir, "claudebot-host-linux-x64"), "released host");
    const inApp = join(bundleDir, bundledHostPath("linux", "x64"));
    await mkdir(dirname(inApp), { recursive: true });
    await writeFile(inApp, opts.bundledHost ?? "released host");
    await chmod(inApp, 0o755);
    for (const name of [
      "Claudebot-1.0.0.AppImage",
      "Claudebot-1.0.0.deb",
      "Claudebot-1.0.0.AppImage.blockmap",
      "unrelated.txt",
    ]) {
      await writeFile(join(bundleDir, name), name);
    }
    await writeFile(
      join(bundleDir, "latest-linux.yml"),
      `version: ${opts.version ?? "1.0.0"}\nfiles: []\n`,
    );
    return {
      inApp,
      run: {
        bundleDir,
        hostDir,
        outDir,
        platform: "linux",
        archs: ["x64"],
        version: "1.0.0",
      } as const,
    };
  }

  test("collects the installers, the blockmap that exists and the metadata, nothing else", async () => {
    const { run } = await linuxRun();
    const collected = await collectDesktopRelease(run);
    expect(collected).toEqual([
      "Claudebot-1.0.0.AppImage",
      "Claudebot-1.0.0.deb",
      "latest-linux.yml",
      "Claudebot-1.0.0.AppImage.blockmap",
    ]);
    expect((await readdir(run.outDir)).toSorted()).toEqual(collected.toSorted());
  });

  test("fails when the bundled host is not the released binary", async () => {
    const { run } = await linuxRun({ bundledHost: "rebuilt host" });
    await expect(collectDesktopRelease(run)).rejects.toThrow(
      "is not the release's claudebot-host-linux-x64",
    );
  });

  test("fails when the bundled host lost its executable bit", async () => {
    const { run, inApp } = await linuxRun();
    await chmod(inApp, 0o644);
    await expect(collectDesktopRelease(run)).rejects.toThrow("not executable");
  });

  test("fails when the metadata names another version", async () => {
    const { run } = await linuxRun({ version: "0.0.0" });
    await expect(collectDesktopRelease(run)).rejects.toThrow(
      "names version 0.0.0, the release is 1.0.0",
    );
  });

  test("fails when an installer was not built", async () => {
    const { run } = await linuxRun();
    await rm(join(run.bundleDir, "Claudebot-1.0.0.deb"));
    await expect(collectDesktopRelease(run)).rejects.toThrow("Claudebot-1.0.0.deb was not built");
  });

  test("macOS: the host inside the update zip is checked too, per arch", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-kit-"));
    dirs.push(root);
    const bundleDir = join(root, "bundle");
    const hostDir = join(root, "hosts");
    await mkdir(hostDir);
    const zips = {
      arm64: "Claudebot-1.0.0-arm64-mac.zip",
      x64: "Claudebot-1.0.0-mac.zip",
    } as const;
    for (const arch of ["arm64", "x64"] as const) {
      await writeFile(join(hostDir, `claudebot-host-darwin-${arch}`), `host ${arch}`);
      const app = join(root, `zip-${arch}`);
      const inZip = join(app, "Claudebot.app/Contents/Resources/claudebot-host");
      await mkdir(dirname(inZip), { recursive: true });
      // The x64 zip carries the arm64 host: the app on disk is right, the zip is not.
      await writeFile(inZip, arch === "x64" ? "host arm64" : `host ${arch}`);
      await mkdir(bundleDir, { recursive: true });
      const zip = Bun.spawn(["zip", "-qr", join(bundleDir, zips[arch]), "Claudebot.app"], {
        cwd: app,
      });
      expect(await zip.exited).toBe(0);
      const inApp = join(bundleDir, bundledHostPath("darwin", arch));
      await mkdir(dirname(inApp), { recursive: true });
      await writeFile(inApp, `host ${arch}`);
      await chmod(inApp, 0o755);
    }
    await writeFile(join(bundleDir, "latest-mac.yml"), "version: 1.0.0\n");
    for (const name of desktopAssets("darwin", ["arm64", "x64"], "1.0.0").installers) {
      await writeFile(join(bundleDir, name), "", { flag: "a" });
    }
    const run = {
      bundleDir,
      hostDir,
      outDir: join(root, "out"),
      platform: "darwin",
      archs: ["arm64", "x64"],
      version: "1.0.0",
    } as const;
    await expect(collectDesktopRelease(run)).rejects.toThrow(
      "Claudebot-1.0.0-mac.zip holds a host",
    );
    await expect(collectDesktopRelease({ ...run, archs: ["arm64"] })).resolves.toContain(
      "Claudebot-1.0.0-arm64-mac.zip",
    );
  });
});
