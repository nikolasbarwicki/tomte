import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { treeFiles, winBrowserFiles } from "./browser-fixture.ts";
import type { Ran, Runner } from "./command-runner.ts";
import { SigningError } from "./signing-kit.ts";
import { verifyWindowsBundle } from "./win-verify.ts";

const T = "AB".repeat(20);
const BUNDLE = "/out/Claudebot-win32-x64";
const RESOURCES = join(BUNDLE, "win-unpacked/resources");
const tree = (files = winBrowserFiles()) => treeFiles(files, "/resources/");

/** What PowerShell's `Get-AuthenticodeSignature` run would print for one file. */
type Signature = { status?: string; thumbprint?: string; timestamped?: boolean };

/** Plays the PowerShell script: one `path|status|thumbprint|timestamped` line per path in the list file it is given. */
function powershell(sign: (path: string) => Signature = () => ({})) {
  const asked: string[][] = [];
  const run: Runner = async (cmd): Promise<Ran> => {
    const paths = (await readFile(cmd.at(-1) as string, "utf8")).split("\n").filter(Boolean);
    asked.push(paths);
    const lines = paths.map((p) => {
      const s = sign(p);
      return `${p}|${s.status ?? "Valid"}|${s.thumbprint ?? T}|${(s.timestamped ?? true) ? "True" : "False"}`;
    });
    return { stdout: lines.join("\n"), stderr: "" };
  };
  return { asked, run };
}

const verify = (run: Runner, files = tree()) =>
  verifyWindowsBundle(run, BUNDLE, "0.1.0", () => {}, files);

describe("verifyWindowsBundle", () => {
  test("checks the installer, the app, the host, the engine and every .exe and .dll of Chrome, nested ones included", async () => {
    const { asked, run } = powershell();
    await verify(run);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual([
      join(BUNDLE, "Claudebot-Setup-0.1.0.exe"),
      join(BUNDLE, "win-unpacked/Claudebot.exe"),
      join(BUNDLE, "win-unpacked/resources/claudebot-host.exe"),
      join(RESOURCES, "browser-engine/agent-browser.exe"),
      ...[
        "chrome-win64/157.0.8103.38/chrome_elf.dll",
        "chrome-win64/D3DCompiler_47.dll",
        "chrome-win64/chrome.dll",
        "chrome-win64/chrome.exe",
        "chrome-win64/chrome_proxy.exe",
        "chrome-win64/libEGL.dll",
      ].map((f) => join(RESOURCES, "browser-engine/chrome", f)),
    ]);
  });

  test("lists the DLLs the bundle holds, not a fixed set", async () => {
    const { asked, run } = powershell();
    await verify(
      run,
      tree([...winBrowserFiles(), "browser-engine/chrome/chrome-win64/new_dll.DLL"]),
    );
    expect(asked[0]).toContain(join(RESOURCES, "browser-engine/chrome/chrome-win64/new_dll.DLL"));
  });

  test("fails on a browser DLL that is not signed, naming it", async () => {
    const { run } = powershell((p) =>
      p.endsWith("libEGL.dll") ? { status: "NotSigned", thumbprint: "", timestamped: false } : {},
    );
    const error = await verify(run).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as Error).message).toContain("libEGL.dll: signature status is NotSigned");
    expect((error as Error).message).toContain("libEGL.dll: no timestamp");
  });

  test("fails on a nested DLL, on the engine and on Chrome without a timestamp", async () => {
    for (const name of ["chrome_elf.dll", "agent-browser.exe", "chrome.exe"]) {
      const { run } = powershell((p) => (p.endsWith(name) ? { timestamped: false } : {}));
      await expect(verify(run)).rejects.toThrow(`${name}: no timestamp`);
    }
  });

  test("fails on a file signed by another certificate than the app", async () => {
    const { run } = powershell((p) =>
      p.endsWith("chrome.dll") ? { thumbprint: "CD".repeat(20) } : {},
    );
    await expect(verify(run)).rejects.toThrow("signed by 2 different certificates");
  });

  test("fails when PowerShell reports fewer files than were asked", async () => {
    const run: Runner = async () => ({ stdout: `a.exe|Valid|${T}|True`, stderr: "" });
    await expect(verify(run)).rejects.toThrow("expected 10 files, checked 1");
  });

  test.each([
    ["the engine", "browser-engine/agent-browser.exe", "agent-browser.exe"],
    ["Chrome's executable", "browser-engine/chrome/chrome-win64/chrome.exe", "chrome.exe"],
  ])("fails without running anything when %s is missing", async (_name, missing, named) => {
    const { asked, run } = powershell();
    const files = winBrowserFiles().filter((f) => f !== missing);
    const error = await verify(run, tree(files)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as Error).message).toContain("the bundled browser is incomplete");
    expect((error as Error).message).toContain(named);
    expect(asked).toEqual([]);
  });

  test("fails when the bundle has a browser folder with no DLLs, or no browser", async () => {
    const { run } = powershell();
    const exes = winBrowserFiles().filter((f) => !f.toLowerCase().endsWith(".dll"));
    await expect(verify(run, tree(exes))).rejects.toThrow("*.dll");
    await expect(verify(run, tree(["claudebot-host.exe"]))).rejects.toThrow(
      "the bundled browser is incomplete",
    );
  });
});
