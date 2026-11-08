import { describe, expect, test } from "bun:test";

import {
  checkSignedMac,
  checkSignedWindows,
  hasEntitlement,
  packagingSigning,
  parseAuthenticodeLines,
  parseCodesignDetails,
  parseDeveloperIdIdentity,
  planSigning,
  localMacSigning,
  SIGNING_SECRETS,
  SigningError,
  signingRequired,
  signingSummary,
} from "./signing-kit.ts";

const filled = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, "x"]));
const MAC = filled(SIGNING_SECRETS.darwin);
const WIN = filled(SIGNING_SECRETS.win32);

describe("planSigning", () => {
  test("all of a platform's secrets make it signed", () => {
    expect(planSigning("darwin", MAC, false)).toEqual({ signed: true, platform: "darwin" });
    expect(planSigning("win32", WIN, true)).toEqual({ signed: true, platform: "win32" });
  });

  test("another platform's secrets do not count", () => {
    expect(planSigning("darwin", WIN, false).signed).toBe(false);
    expect(planSigning("win32", MAC, false).signed).toBe(false);
  });

  test("no secrets leave the release unsigned and say why, unless signing is required", () => {
    const decision = planSigning("win32", {}, false);
    expect(decision).toMatchObject({ signed: false, platform: "win32" });
    expect(decision.signed ? "" : decision.reason).toContain("WINDOWS_CERTIFICATE_PFX");
    expect(() => planSigning("win32", {}, true)).toThrow(
      "win32 signing is required (CLAUDEBOT_REQUIRE_SIGNING=true or --sign) but none of its secrets are set",
    );
  });

  test("blank and whitespace-only secrets count as unset", () => {
    const env = { ...MAC, APPLE_API_KEY_ID: "  ", MACOS_CERTIFICATE_P12: "" };
    expect(() => planSigning("darwin", env, false)).toThrow(SigningError);
    const none = Object.fromEntries(SIGNING_SECRETS.darwin.map((n) => [n, " "]));
    expect(planSigning("darwin", none, false).signed).toBe(false);
  });

  test("a partly configured platform always fails, required or not, naming what is missing", () => {
    const { APPLE_API_KEY_ID: _id, APPLE_API_ISSUER: _issuer, ...partial } = MAC;
    for (const required of [false, true]) {
      expect(() => planSigning("darwin", partial, required)).toThrow(
        "partly configured: APPLE_API_KEY_ID, APPLE_API_ISSUER are not set",
      );
    }
  });

  test("an error never contains a secret's value", () => {
    const env = { MACOS_CERTIFICATE_P12: "hunter2-secret-value" };
    expect(() => planSigning("darwin", env, false)).toThrow(/^(?!.*hunter2)/);
  });
});

describe("signingRequired", () => {
  test("only the exact value true requires signing", () => {
    expect(signingRequired({ CLAUDEBOT_REQUIRE_SIGNING: "true" })).toBe(true);
    expect(signingRequired({ CLAUDEBOT_REQUIRE_SIGNING: " true " })).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      expect(signingRequired({ CLAUDEBOT_REQUIRE_SIGNING: value })).toBe(false);
    }
  });
});

describe("packagingSigning", () => {
  test("is unsigned without --sign even when credentials are in the environment", () => {
    expect(packagingSigning("darwin", MAC, false)).toMatchObject({ signed: false });
    expect(packagingSigning("win32", WIN, false)).toMatchObject({ signed: false });
  });

  test("--sign needs every secret of the platform and fails before anything is built otherwise", () => {
    expect(packagingSigning("darwin", MAC, true)).toEqual({ signed: true, platform: "darwin" });
    expect(() => packagingSigning("darwin", {}, true)).toThrow(SigningError);
    expect(() => packagingSigning("win32", MAC, true)).toThrow(SigningError);
  });

  test("the requirement signs without --sign, so an unsigned build is impossible", () => {
    const required = { CLAUDEBOT_REQUIRE_SIGNING: "true" };
    expect(packagingSigning("darwin", { ...required, ...MAC }, false).signed).toBe(true);
    expect(() => packagingSigning("darwin", required, false)).toThrow(SigningError);
  });

  test("Linux is never signed, not even when signing is required", () => {
    expect(packagingSigning("linux", { CLAUDEBOT_REQUIRE_SIGNING: "true" }, true)).toMatchObject({
      signed: false,
      platform: "linux",
    });
  });
});

describe("signingSummary", () => {
  test("names every platform and is loud about an unsigned release", () => {
    const text = signingSummary(
      [planSigning("darwin", MAC, false), planSigning("win32", {}, false)],
      false,
    );
    expect(text).toContain("NOT fully signed");
    expect(text).toContain("- darwin: signed");
    expect(text).toContain("- win32: UNSIGNED");
    expect(text).toContain("a missing secret leaves that platform unsigned");
  });

  test("says so when everything is signed and the requirement is on", () => {
    const text = signingSummary(
      [planSigning("darwin", MAC, true), planSigning("win32", WIN, true)],
      true,
    );
    expect(text).toContain("macOS and Windows are signed");
    expect(text).toContain("a missing secret fails the release");
  });
});

// `codesign -dvv` as macOS prints it for a Developer ID signed app (stderr).
const SIGNED = `Executable=/x/Claudebot.app/Contents/MacOS/Claudebot
Identifier=dev.claudebot.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
Signature size=9012
Authority=Developer ID Application: Acme Inc (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 8, 2026 at 09:00:00
Info.plist entries=22
TeamIdentifier=ABCDE12345
`;
const ADHOC = `Executable=/x/claudebot-host
Identifier=claudebot-host
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=500 flags=0x20002(adhoc,linker-signed) hashes=10+0 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key>
<true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
</dict></plist>`;

describe("parseCodesignDetails", () => {
  test("reads the team, the authorities, the hardened runtime and the secure timestamp", () => {
    expect(parseCodesignDetails(SIGNED)).toEqual({
      authorities: [
        "Developer ID Application: Acme Inc (ABCDE12345)",
        "Developer ID Certification Authority",
        "Apple Root CA",
      ],
      teamId: "ABCDE12345",
      hardenedRuntime: true,
      secureTimestamp: true,
      adhoc: false,
    });
  });

  test("an ad-hoc signature has no team, no runtime flag and no timestamp", () => {
    expect(parseCodesignDetails(ADHOC)).toEqual({
      authorities: [],
      teamId: undefined,
      hardenedRuntime: false,
      secureTimestamp: false,
      adhoc: true,
    });
  });

  test("the runtime flag is found among several flags", () => {
    const text =
      "CodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1+1 location=embedded";
    expect(parseCodesignDetails(text).hardenedRuntime).toBe(true);
  });
});

describe("hasEntitlement", () => {
  test("is true only for a key set to true", () => {
    expect(hasEntitlement(ENTITLEMENTS, "com.apple.security.cs.allow-jit")).toBe(true);
    expect(hasEntitlement(ENTITLEMENTS, "com.apple.security.cs.disable-library-validation")).toBe(
      false,
    );
    const off = "<key>com.apple.security.cs.allow-jit</key>\n<false/>";
    expect(hasEntitlement(off, "com.apple.security.cs.allow-jit")).toBe(false);
  });

  test("a dot in the key does not match any character", () => {
    expect(
      hasEntitlement(
        "<key>comXappleXsecurityXcsXallow-jit</key><true/>",
        "com.apple.security.cs.allow-jit",
      ),
    ).toBe(false);
  });
});

describe("checkSignedMac", () => {
  const app = { label: "the app", info: parseCodesignDetails(SIGNED) };
  const host = { label: "the host", info: parseCodesignDetails(SIGNED) };

  test("accepts an app and a host signed by the same Developer ID with the host's entitlements", () => {
    expect(checkSignedMac(app, host, ENTITLEMENTS)).toEqual([]);
  });

  test("rejects a host signed by another team or another certificate", () => {
    const other = {
      label: "the host",
      info: {
        ...host.info,
        teamId: "ZZZZZ99999",
        authorities: ["Developer ID Application: Other (ZZZZZ99999)"],
      },
    };
    const problems = checkSignedMac(app, other, ENTITLEMENTS);
    expect(problems).toContain(
      "the host's Team ID (ZZZZZ99999) differs from the app's (ABCDE12345)",
    );
    expect(problems.some((p) => p.includes("is signed by"))).toBe(true);
  });

  test("rejects an ad-hoc host, one without the hardened runtime or a timestamp, and a missing entitlement", () => {
    const adhoc = { label: "the host", info: parseCodesignDetails(ADHOC) };
    const problems = checkSignedMac(app, adhoc, "<plist><dict></dict></plist>");
    expect(problems).toContain("the host is ad-hoc signed");
    expect(problems).toContain("the host has no Team ID");
    expect(problems).toContain("the host does not have the hardened runtime");
    expect(problems).toContain("the host has no secure timestamp");
    expect(problems).toContain("the host lacks the com.apple.security.cs.allow-jit entitlement");
  });

  test("rejects a certificate that is not a Developer ID Application one", () => {
    const dev = {
      label: "the app",
      info: { ...app.info, authorities: ["Apple Development: Someone (ABCDE12345)"] },
    };
    expect(checkSignedMac(dev, host, ENTITLEMENTS).join("\n")).toContain(
      "the app is not signed with a Developer ID Application certificate",
    );
  });
});

describe("parseDeveloperIdIdentity", () => {
  const HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
  const line = (n: number, hash: string, name: string) => `  ${n}) ${hash} "${name}"`;

  test("reads the identity out of `security find-identity -v` output", () => {
    const out = [
      line(1, HASH, "Developer ID Application: Acme Inc (ABCDE12345)"),
      "     1 valid identities found",
    ].join("\n");
    expect(parseDeveloperIdIdentity(out)).toEqual({
      hash: HASH,
      name: "Developer ID Application: Acme Inc (ABCDE12345)",
      teamId: "ABCDE12345",
    });
  });

  test("fails when the certificate holds none, or only another kind", () => {
    expect(() => parseDeveloperIdIdentity("     0 valid identities found")).toThrow(SigningError);
    expect(() =>
      parseDeveloperIdIdentity(line(1, HASH, "Apple Development: Someone (ABCDE12345)")),
    ).toThrow("no valid Developer ID Application identity");
  });

  test("fails when it holds two, since the app and the host must share one", () => {
    const out = [
      line(1, HASH, "Developer ID Application: Acme Inc (ABCDE12345)"),
      line(2, HASH.replace(/0/g, "A"), "Developer ID Application: Other (ZZZZZ99999)"),
    ].join("\n");
    expect(() => parseDeveloperIdIdentity(out)).toThrow("exactly one");
  });
});

describe("Authenticode", () => {
  const T = "AB".repeat(20);
  const lines = (...rows: string[]) => rows.join("\n");

  test("parses path|status|thumbprint|timestamped lines, paths with bars included", () => {
    expect(parseAuthenticodeLines(lines(`C:\\a|b\\x.exe|Valid|${T}|True`, ""))).toEqual([
      { path: "C:\\a|b\\x.exe", status: "Valid", thumbprint: T, timestamped: true },
    ]);
    expect(() => parseAuthenticodeLines("only|three|parts")).toThrow(SigningError);
  });

  test("accepts files that are valid, timestamped and share one certificate", () => {
    const records = parseAuthenticodeLines(lines(`a.exe|Valid|${T}|True`, `b.exe|Valid|${T}|True`));
    expect(checkSignedWindows(records)).toEqual([]);
  });

  test("rejects an unsigned file, a missing timestamp and a different certificate", () => {
    const records = parseAuthenticodeLines(
      lines(
        `a.exe|Valid|${T}|True`,
        "b.exe|NotSigned||False",
        `c.exe|Valid|${"CD".repeat(20)}|True`,
      ),
    );
    const problems = checkSignedWindows(records);
    expect(problems).toContain("b.exe: signature status is NotSigned");
    expect(problems).toContain("b.exe: no signing certificate");
    expect(problems).toContain("b.exe: no timestamp");
    expect(problems).toContain("the files are signed by 3 different certificates");
  });

  test("rejects an empty check", () => {
    expect(checkSignedWindows([])).toEqual(["no signed Windows files were checked"]);
  });
});

describe("localMacSigning", () => {
  const KEYCHAIN = "/tmp/synthetic/run.keychain-db";
  const IDENTITY = "0123456789ABCDEF0123456789ABCDEF01234567";
  const NOTARY = {
    APPLE_API_KEY: "/tmp/synthetic/key.p8",
    APPLE_API_KEY_ID: "SYNTHKEY",
    APPLE_API_ISSUER: "synthetic-issuer",
  };
  const flags = {
    keychain: KEYCHAIN,
    identity: IDENTITY,
    notary: undefined,
    ascProfile: undefined,
    ascBin: undefined,
    notaryRecord: undefined,
  };
  const ASC = {
    ...flags,
    notary: "asc",
    ascProfile: "ASC API",
    ascBin: "/opt/homebrew/bin/asc",
    notaryRecord: "/tmp/synthetic/notary-app.json",
  };
  const here = { platform: "darwin", sign: true, ci: false } as const;

  test("is off, and never reads the environment, when neither flag is given", () => {
    expect(
      localMacSigning({ ...flags, keychain: undefined, identity: undefined }, {}, here),
    ).toBeUndefined();
  });

  test("returns the keychain, the identity hash and the notarization key", () => {
    expect(localMacSigning(flags, NOTARY, here)).toEqual({
      keychain: KEYCHAIN,
      identity: IDENTITY,
      notary: {
        kind: "p8",
        key: "/tmp/synthetic/key.p8",
        keyId: "SYNTHKEY",
        issuer: "synthetic-issuer",
      },
    });
  });

  test("--local-notary p8 is the same as the default", () => {
    expect(localMacSigning({ ...flags, notary: "p8" }, NOTARY, here)?.notary.kind).toBe("p8");
  });

  test("the asc backend returns the profile, the binary and the record path and reads no API key", () => {
    expect(localMacSigning(ASC, {}, here)).toEqual({
      keychain: KEYCHAIN,
      identity: IDENTITY,
      notary: {
        kind: "asc",
        profile: "ASC API",
        bin: "/opt/homebrew/bin/asc",
        record: "/tmp/synthetic/notary-app.json",
      },
    });
  });

  test.each([
    ["one flag alone", { ...flags, identity: undefined }, NOTARY, here],
    ["no --sign", flags, NOTARY, { ...here, sign: false }],
    ["not macOS", flags, NOTARY, { ...here, platform: "linux" as const }],
    ["CI", flags, NOTARY, { ...here, ci: true }],
    ["a relative keychain", { ...flags, keychain: "run.keychain-db" }, NOTARY, here],
    ["an identity by name", { ...flags, identity: "Developer ID Application: Acme" }, NOTARY, here],
    ["a lower-case hash", { ...flags, identity: IDENTITY.toLowerCase() }, NOTARY, here],
    ["a half-named notarization key", flags, { ...NOTARY, APPLE_API_ISSUER: " " }, here],
    ["an unknown notary backend", { ...flags, notary: "keychain-profile" }, NOTARY, here],
    ["asc flags without --local-notary asc", { ...flags, ascProfile: "ASC API" }, NOTARY, here],
    ["asc without a profile", { ...ASC, ascProfile: undefined }, {}, here],
    ["asc without a binary", { ...ASC, ascBin: undefined }, {}, here],
    ["asc without a record path", { ...ASC, notaryRecord: undefined }, {}, here],
    ["asc with a relative binary", { ...ASC, ascBin: "asc" }, {}, here],
    ["asc with a relative record path", { ...ASC, notaryRecord: "record.json" }, {}, here],
    ["asc in CI", ASC, {}, { ...here, ci: true }],
  ])("refuses %s", (_name, f, env, where) => {
    expect(() => localMacSigning(f, env, where)).toThrow(SigningError);
  });
});
