import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ran, Runner } from "./command-runner.ts";
import {
  dmgCommands,
  macAppCommands,
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
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>`;

/** Answers `codesign -dvv` with `team`'s details and records every command. */
function recorder(team = "ABCDE12345", detailsText = details(team)) {
  const calls: string[][] = [];
  const run: Runner = async (cmd): Promise<Ran> => {
    calls.push([...cmd]);
    if (cmd[0] === "codesign" && cmd[1] === "-dvv") return { stdout: "", stderr: detailsText };
    if (cmd[0] === "codesign" && cmd[1] === "-d") return { stdout: ENTITLEMENTS, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("verifyMacApp", () => {
  test("runs the checks CI always ran, in the same order, and returns the Team ID", async () => {
    const { calls, run } = recorder();
    const team = await verifyMacApp(run, "/b/Claudebot.app", () => {});
    const host = "/b/Claudebot.app/Contents/Resources/claudebot-host";
    expect(team).toBe("ABCDE12345");
    expect(calls).toEqual([
      ["codesign", "--verify", "--deep", "--strict", "--verbose=2", "/b/Claudebot.app"],
      ["spctl", "--assess", "--type", "execute", "--verbose=4", "/b/Claudebot.app"],
      ["xcrun", "stapler", "validate", "/b/Claudebot.app"],
      ["codesign", "--verify", "--strict", "--verbose=2", host],
      ["codesign", "-dvv", "/b/Claudebot.app"],
      ["codesign", "-dvv", host],
      ["codesign", "-d", "--entitlements", ":-", host],
    ]);
    expect(Object.values(macAppCommands("/b/Claudebot.app"))).toEqual(calls);
  });

  test("fails on an app without a secure timestamp", async () => {
    const { run } = recorder("ABCDE12345", details("ABCDE12345", ""));
    await expect(verifyMacApp(run, "/b/Claudebot.app", () => {})).rejects.toThrow(
      "no secure timestamp",
    );
  });
});

describe("verifyMacBundle", () => {
  test("checks the unpacked app, then the app inside the update zip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-mac-verify-test-"));
    try {
      const { calls, run } = recorder();
      const teams = await verifyMacBundle(run, dir, "0.1.0", ["arm64"], () => {});
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
      expect(calls.filter((c) => c[1] === "-dvv")).toHaveLength(4);
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
    const { run } = recorder("ABCDE12345", text);
    const error = await verifyDmg(run, "/b/x.dmg", "ABCDE12345", () => {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as Error).message).toContain(message);
  });
});
