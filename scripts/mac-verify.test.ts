import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { macBrowserFiles, treeFiles } from "./browser-fixture.ts";
import { CommandError, type Ran, type Runner } from "./command-runner.ts";
import {
  dmgCommands,
  macAppCommands,
  macPartCommands,
  verifyDmg,
  verifyMacApp,
  verifyMacBundle,
} from "./mac-verify.ts";
import { SigningError } from "./signing-kit.ts";

const details = (team: string, extra = "Timestamp=Nov 8, 2026 at 09:00:00\n") =>
  `CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded
Authority=Developer ID Application: Synthetic Co (${team})
Authority=Developer ID Certification Authority
${extra}TeamIdentifier=${team}
`;
const ENTITLEMENTS = `<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>`;
const WITHOUT_LIBRARY_VALIDATION = ENTITLEMENTS.split("\n").slice(0, 2).join("\n");

const APP = "/b/Claudebot.app";
const RESOURCES = `${APP}/Contents/Resources`;
const tree = (arch = "arm64") => treeFiles(macBrowserFiles(arch), "/Contents/Resources/");

interface Answers {
  /** `codesign -dvv` stderr for a path; default is signed by `team`. */
  details?: (path: string) => string | undefined;
  /** `codesign -d --entitlements` stdout for a path. */
  entitlements?: (path: string) => string | undefined;
  /** Paths whose `codesign --verify` exits non-zero. */
  invalid?: (path: string) => boolean;
}

/** Answers `codesign` with `team`'s details (or what `answers` says per path) and records every command. */
function recorder(team = "ABCDE12345", answers: Answers = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd): Promise<Ran> => {
    calls.push([...cmd]);
    const path = cmd.at(-1) as string;
    if (cmd[0] === "codesign" && cmd[1] === "--verify" && answers.invalid?.(path)) {
      throw new CommandError("codesign --verify", 1, "", `${path}: invalid signature`);
    }
    if (cmd[0] === "codesign" && cmd[1] === "-dvv") {
      return { stdout: "", stderr: answers.details?.(path) ?? details(team) };
    }
    if (cmd[0] === "codesign" && cmd[1] === "-d") {
      return { stdout: answers.entitlements?.(path) ?? ENTITLEMENTS, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

const inResources = (rel: string) => join(RESOURCES, rel);
const FRAMEWORK = "Google Chrome for Testing Framework.framework";
const CHROME = "browser-engine/chrome/chrome-mac-arm64/Google Chrome for Testing.app";
const VERSION = `${CHROME}/Contents/Frameworks/${FRAMEWORK}/Versions/157.0.8103.38`;

describe("verifyMacApp", () => {
  test("runs the checks CI always ran, in the same order, then the browser's", async () => {
    const { calls, run } = recorder();
    const team = await verifyMacApp(run, APP, "arm64", () => {}, tree());
    const host = `${RESOURCES}/claudebot-host`;
    expect(team).toBe("ABCDE12345");
    expect(calls.slice(0, 7)).toEqual([
      ["codesign", "--verify", "--deep", "--strict", "--verbose=2", APP],
      ["spctl", "--assess", "--type", "execute", "--verbose=4", APP],
      ["xcrun", "stapler", "validate", APP],
      ["codesign", "--verify", "--strict", "--verbose=2", host],
      ["codesign", "-dvv", APP],
      ["codesign", "-dvv", host],
      ["codesign", "-d", "--entitlements", ":-", host],
    ]);
  });

  test("checks the engine, Chrome (deeply), its framework and every Helper app, executable and library found", async () => {
    const { calls, run } = recorder();
    await verifyMacApp(run, APP, "arm64", () => {}, tree());
    const verified = calls.filter((c) => c[1] === "--verify").map((c) => c.at(-1));
    expect(verified.slice(0, 2)).toEqual([APP, `${RESOURCES}/claudebot-host`]);
    const parts = verified.slice(2);
    expect(new Set(parts)).toEqual(
      new Set(
        [
          "browser-engine/agent-browser",
          CHROME,
          `${CHROME}/Contents/Frameworks/${FRAMEWORK}`,
          `${VERSION}/Helpers/Google Chrome for Testing Helper (Aperitif).app`,
          `${VERSION}/Helpers/Google Chrome for Testing Helper (GPU).app`,
          `${VERSION}/Helpers/Google Chrome for Testing Helper (Renderer).app`,
          `${VERSION}/Helpers/Google Chrome for Testing Helper.app`,
          `${VERSION}/Helpers/chrome_crashpad_handler`,
          `${VERSION}/Libraries/WidevineCdm/_platform_specific/mac_arm64/libwidevinecdm.dylib`,
          `${VERSION}/Libraries/libvulkan.dylib`,
        ].map(inResources),
      ),
    );
    expect(parts).toHaveLength(10);
    const deep = calls.filter((c) => c.includes("--deep")).map((c) => c.at(-1));
    expect(deep).toEqual([APP, inResources(CHROME)]);
    // Entitlements are read off the code that runs, not off libraries or the engine.
    const entitled = calls.filter((c) => c[1] === "-d").map((c) => c.at(-1));
    expect(entitled).toHaveLength(1 + 1 + 4);
    expect(entitled).toContain(inResources(CHROME));
    expect(entitled).not.toContain(inResources("browser-engine/agent-browser"));
  });

  test("the static commands are what the local plan prints", async () => {
    const { calls, run } = recorder();
    await verifyMacApp(run, APP, "arm64", () => {}, tree());
    const planned = Object.values(macAppCommands(APP, "arm64"));
    expect(calls.slice(0, planned.length)).toEqual(planned);
    const helper = macPartCommands(
      inResources(`${VERSION}/Helpers/Google Chrome for Testing Helper.app`),
      "app",
    );
    expect(calls).toContainEqual(helper.signature);
    expect(calls).toContainEqual(helper.entitlements);
  });

  test("fails on an app without a secure timestamp", async () => {
    const { run } = recorder("ABCDE12345", { details: () => details("ABCDE12345", "") });
    await expect(verifyMacApp(run, APP, "arm64", () => {}, tree())).rejects.toThrow(
      "no secure timestamp",
    );
  });

  test.each([
    ["agent-browser", "browser-engine/agent-browser"],
    ["Chrome for Testing.app", CHROME],
    ["its framework", `${CHROME}/Contents/Frameworks/${FRAMEWORK}`],
  ])("fails when %s is missing, naming it", async (_name, rel) => {
    const missing = macBrowserFiles("arm64").filter((f) => !f.startsWith(rel));
    const { calls, run } = recorder();
    await expect(
      verifyMacApp(run, APP, "arm64", () => {}, treeFiles(missing, "/Contents/Resources/")),
    ).rejects.toThrow(inResources(rel));
    expect(calls).toEqual([]);
  });

  test("fails when the bundle has no browser at all", async () => {
    const { run } = recorder();
    await expect(
      verifyMacApp(
        run,
        APP,
        "arm64",
        () => {},
        treeFiles(["claudebot-host"], "/Contents/Resources/"),
      ),
    ).rejects.toThrow("the bundled browser is incomplete");
  });

  test("fails when the framework holds no Helper app, or no Helpers folder", async () => {
    const { run } = recorder();
    const apps = macBrowserFiles("arm64").filter((f) => !/Helpers\/[^/]*\.app\//.test(f));
    await expect(
      verifyMacApp(run, APP, "arm64", () => {}, treeFiles(apps, "/Contents/Resources/")),
    ).rejects.toThrow("holds no Helper app");
    const folder = macBrowserFiles("arm64").filter((f) => !f.includes("/Helpers/"));
    await expect(
      verifyMacApp(run, APP, "arm64", () => {}, treeFiles(folder, "/Contents/Resources/")),
    ).rejects.toThrow("has no Helpers folder");
  });

  test("fails for the other arch's Chrome folder", async () => {
    const { run } = recorder();
    await expect(verifyMacApp(run, APP, "x64", () => {}, tree("arm64"))).rejects.toThrow(
      "chrome-mac-x64",
    );
  });

  test("fails on a Helper app that is ad-hoc signed, naming it", async () => {
    const adhoc = `CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;
    const { run } = recorder("ABCDE12345", {
      details: (p) => (p.endsWith("Helper (Aperitif).app") ? adhoc : undefined),
    });
    const error = await verifyMacApp(run, APP, "arm64", () => {}, tree()).catch((e) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect(error.message).toContain("Helper (Aperitif).app is ad-hoc signed");
    expect(error.message).toContain("Helper (Aperitif).app has no Team ID");
  });

  test("fails on a library or the crash handler left with another team's signature", async () => {
    const google = details("EQHXZ8M8AV").replaceAll("Synthetic Co", "Google LLC");
    const { run } = recorder("ABCDE12345", {
      details: (p) => (p.endsWith("libwidevinecdm.dylib") ? google : undefined),
    });
    await expect(verifyMacApp(run, APP, "arm64", () => {}, tree())).rejects.toThrow(
      "libwidevinecdm.dylib's Team ID (EQHXZ8M8AV) differs from the app's (ABCDE12345)",
    );
  });

  test("fails on Chrome signed by another team", async () => {
    const { run } = recorder("ABCDE12345", {
      details: (p) =>
        p.endsWith("Google Chrome for Testing.app") ? details("ZZZZZ99999") : undefined,
    });
    await expect(verifyMacApp(run, APP, "arm64", () => {}, tree())).rejects.toThrow(
      "Google Chrome for Testing.app's Team ID (ZZZZZ99999) differs",
    );
  });

  test("fails on Chrome or a Helper app without disable-library-validation, and on the host without it", async () => {
    for (const path of ["Google Chrome for Testing.app", "Helper (GPU).app", "claudebot-host"]) {
      const { run } = recorder("ABCDE12345", {
        entitlements: (p) => (p.endsWith(path) ? WITHOUT_LIBRARY_VALIDATION : undefined),
      });
      await expect(verifyMacApp(run, APP, "arm64", () => {}, tree())).rejects.toThrow(
        "lacks the com.apple.security.cs.disable-library-validation entitlement",
      );
    }
  });

  test("a failing codesign --verify on any browser part fails the app", async () => {
    for (const path of ["agent-browser", "chrome_crashpad_handler", "Helper (Renderer).app"]) {
      const { run } = recorder("ABCDE12345", { invalid: (p) => p.endsWith(path) });
      await expect(verifyMacApp(run, APP, "arm64", () => {}, tree())).rejects.toThrow(
        "invalid signature",
      );
    }
  });
});

describe("verifyMacBundle", () => {
  test("checks the unpacked app, then the app inside the update zip, browser included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-mac-verify-test-"));
    try {
      const { calls, run } = recorder();
      const teams = await verifyMacBundle(run, dir, "0.1.0", ["arm64"], () => {}, tree());
      expect(teams).toEqual(["ABCDE12345", "ABCDE12345"]);
      const unzip = calls.findIndex((c) => c[0] === "ditto");
      expect(calls[unzip]?.slice(0, 4)).toEqual([
        "ditto",
        "-x",
        "-k",
        join(dir, "Claudebot-0.1.0-arm64-mac.zip"),
      ]);
      expect(calls[0]?.at(-1)).toBe(join(dir, "mac-arm64/Claudebot.app"));
      expect(calls[unzip + 1]?.at(-1)).toEndWith("arm64/Claudebot.app");
      const chromeChecks = calls.filter(
        (c) => c[1] === "-dvv" && c.at(-1)?.endsWith("Google Chrome for Testing.app"),
      );
      expect(chromeChecks).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when only the app inside the update zip lacks its browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-mac-verify-test-"));
    try {
      const { run } = recorder();
      const full = tree();
      const files = {
        exists: (p: string) =>
          p.includes("/mac-arm64/") ? full.exists(p) : Promise.resolve(false),
        list: (d: string) => full.list(d),
      };
      await expect(verifyMacBundle(run, dir, "0.1.0", ["arm64"], () => {}, files)).rejects.toThrow(
        "the bundled browser is incomplete",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyDmg", () => {
  test("runs Gatekeeper, the ticket check, the signature check and reads the signer", async () => {
    const { calls, run } = recorder();
    await verifyDmg(run, "/b/Claudebot.dmg", "ABCDE12345", () => {});
    expect(calls).toEqual(Object.values(dmgCommands("/b/Claudebot.dmg")));
    expect(calls[0]).toEqual(
      expect.arrayContaining(["spctl", "-t", "open", "context:primary-signature"]),
    );
  });

  test.each([
    ["another team", details("ZZZZZ99999"), "Team ID is ZZZZZ99999"],
    ["no secure timestamp", details("ABCDE12345", ""), "no secure timestamp"],
    [
      "ad hoc",
      "CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n",
      "signed ad hoc",
    ],
  ])("fails for %s", async (_name, text, message) => {
    const { run } = recorder("ABCDE12345", { details: () => text });
    const error = await verifyDmg(run, "/b/x.dmg", "ABCDE12345", () => {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as Error).message).toContain(message);
  });
});
