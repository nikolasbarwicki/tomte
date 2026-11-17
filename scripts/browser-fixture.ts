// The file layout of the bundled browser in a packaged app, as paths, for the tests of the signing checks (no real Chrome
// is unpacked): macOS, with the Helper names of Chrome for Testing 157 and one renamed helper to prove none is hard-coded,
// and Windows. Paths are relative to the app's `resources` folder; `treeFiles` serves them as a {@link BundleFiles}.
import { dirname, join } from "node:path";

import type { BundleFiles } from "./bundle-files.ts";

const FRAMEWORK = "Google Chrome for Testing Framework.framework";

/** The macOS browser of one arch, relative to `Tomte.app/Contents/Resources`. */
export function macBrowserFiles(arch: string): string[] {
  const chrome = `browser-engine/chrome/chrome-mac-${arch}/Google Chrome for Testing.app`;
  const version = `${chrome}/Contents/Frameworks/${FRAMEWORK}/Versions/157.0.8103.38`;
  const helper = (name: string) =>
    `${version}/Helpers/Google Chrome for Testing Helper${name}.app/Contents/MacOS/Google Chrome for Testing Helper${name}`;
  return [
    "browser-engine/agent-browser",
    `${chrome}/Contents/MacOS/Google Chrome for Testing`,
    `${version}/${FRAMEWORK.replace(".framework", "")}`,
    helper(""),
    helper(" (GPU)"),
    helper(" (Renderer)"),
    helper(" (Aperitif)"),
    `${version}/Helpers/chrome_crashpad_handler`,
    `${version}/Libraries/libvulkan.dylib`,
    `${version}/Libraries/WidevineCdm/_platform_specific/mac_${arch}/libwidevinecdm.dylib`,
    `${version}/Libraries/vk_swiftshader_icd.json`,
  ];
}

/** The Windows browser, relative to `win-unpacked/resources`: Chrome's executables and DLLs, one in a version folder, and data files. */
export function winBrowserFiles(): string[] {
  const chrome = "browser-engine/chrome/chrome-win64";
  return [
    "browser-engine/agent-browser.exe",
    `${chrome}/chrome.exe`,
    `${chrome}/chrome_proxy.exe`,
    `${chrome}/chrome.dll`,
    `${chrome}/D3DCompiler_47.dll`,
    `${chrome}/libEGL.dll`,
    `${chrome}/157.0.8103.38/chrome_elf.dll`,
    `${chrome}/icudtl.dat`,
    `${chrome}/locales/en-US.pak`,
  ];
}

/**
 * A {@link BundleFiles} over `relative` paths under whatever precedes `marker` in a path (`Tomte.app/Contents/Resources`
 * or `win-unpacked/resources`), so one tree answers for every app a test checks, whichever folder it is in.
 */
export function treeFiles(relative: readonly string[], marker: string): BundleFiles {
  const files = new Set(relative);
  const children = new Map<string, Map<string, "dir" | "file">>();
  for (const f of files) {
    for (let p = f, kind: "dir" | "file" = "file"; p !== "."; p = dirname(p), kind = "dir") {
      const parent = dirname(p);
      const siblings = children.get(parent) ?? new Map();
      siblings.set(p.slice(parent === "." ? 0 : parent.length + 1), kind);
      children.set(parent, siblings);
    }
  }
  const rel = (path: string) => {
    const at = path.indexOf(marker);
    return at < 0
      ? undefined
      : join(path.slice(at + marker.length)).replace(/^[\\/]+|[\\/]+$/g, "");
  };
  return {
    exists: async (path) => {
      const r = rel(path);
      return r !== undefined && (files.has(r) || children.has(r));
    },
    list: async (dir) => {
      const r = rel(dir) || ".";
      const entries = children.get(r);
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
  };
}
