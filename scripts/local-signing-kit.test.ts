import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  type LocalInputs,
  inputProblems,
  LOCAL_ENV,
  parseKeychainList,
  parseNotarySubmission,
  parseState,
  placeholderSecrets,
  readLocalInputs,
  replaceUpdateFile,
  resolveLocalConfig,
  Secret,
  serializeState,
  show,
  UsageError,
  withoutKeychain,
} from "./local-signing-kit.ts";

const FULL: LocalInputs = {
  p12File: "/synthetic/id.p12",
  p12PasswordFile: undefined,
  p12Password: "synthetic-password",
  apiKeyFile: "/synthetic/key.p8",
  apiKeyId: "SYNTHKEY",
  apiIssuer: "synthetic-issuer",
};

const resolve = (
  over: Partial<Parameters<typeof resolveLocalConfig>[0]["flags"]> = {},
  rest = {},
) =>
  resolveLocalConfig({
    flags: {
      out: "/work/out",
      version: undefined,
      arch: [],
      confirm: true,
      addToSearchList: false,
      ...over,
    },
    inputs: FULL,
    platform: "darwin",
    ci: false,
    repoRoot: "/repo",
    hostVersion: "0.3.0",
    runId: "r1",
    secrets: placeholderSecrets(),
    ...rest,
  });

describe("Secret", () => {
  test("prints as its label however it is formatted", () => {
    const secret = new Secret("p12-password", "synthetic-value");
    expect(String(secret)).toBe("<p12-password>");
    expect(JSON.stringify({ secret })).toBe('{"secret":"<p12-password>"}');
    expect(show(secret)).toBe("<p12-password>");
    expect(show("plain")).toBe("plain");
  });
});

describe("readLocalInputs and inputProblems", () => {
  test("reads the CLAUDEBOT_LOCAL_* names and treats blank as unset", () => {
    const inputs = readLocalInputs({
      [LOCAL_ENV.p12File]: " /a/b.p12 ",
      [LOCAL_ENV.apiKeyId]: "  ",
    });
    expect(inputs.p12File).toBe("/a/b.p12");
    expect(inputs.apiKeyId).toBeUndefined();
  });

  test("accepts a complete set with the password in the environment", () => {
    expect(inputProblems(FULL)).toEqual([]);
  });

  test("names every missing variable, not its value", () => {
    const problems = inputProblems(readLocalInputs({}));
    expect(problems).toEqual(
      expect.arrayContaining([
        `${LOCAL_ENV.p12File} is not set`,
        `${LOCAL_ENV.apiKeyFile} is not set`,
        `${LOCAL_ENV.apiKeyId} is not set`,
        `${LOCAL_ENV.apiIssuer} is not set`,
      ]),
    );
    expect(problems.join()).toContain("exactly one of");
  });

  test("the password comes from exactly one place", () => {
    const both = { ...FULL, p12PasswordFile: "/synthetic/pw" };
    expect(inputProblems(both).join()).toContain("exactly one of");
    expect(
      inputProblems({ ...FULL, p12Password: undefined, p12PasswordFile: "/synthetic/pw" }),
    ).toEqual([]);
  });

  test("a relative path is refused", () => {
    expect(inputProblems({ ...FULL, apiKeyFile: "key.p8" })).toEqual([
      `${LOCAL_ENV.apiKeyFile} must be an absolute path`,
    ]);
  });
});

describe("resolveLocalConfig", () => {
  test("lays out everything inside --out and defaults the version to the host's", () => {
    const config = resolve();
    const p = config.paths;
    expect(config.version).toBe("0.3.0");
    expect(p.keychain).toBe("/work/out/.signing/r1.keychain-db");
    expect(p.stagedHost).toBe("/work/out/host/claudebot-host-darwin-arm64");
    expect(p.dmg).toBe("/work/out/Claudebot-darwin-arm64/Claudebot-0.3.0-arm64.dmg");
    expect(p.zip).toBe("/work/out/Claudebot-darwin-arm64/Claudebot-0.3.0-arm64-mac.zip");
    expect(p.app).toBe("/work/out/Claudebot-darwin-arm64/mac-arm64/Claudebot.app");
    expect(p.artifacts).toBe("/work/out/artifacts");
    expect(config.problems).toEqual([]);
  });

  test("lists what would make a run refuse and still resolves", () => {
    const config = resolve({ confirm: false }, { ci: true, platform: "linux" });
    expect(config.problems).toEqual([
      expect.stringContaining("CI"),
      expect.stringContaining("needs macOS"),
      expect.stringContaining("--confirm-keychain-and-notary-upload"),
    ]);
  });

  test.each([
    ["no --out", { out: undefined }],
    ["x64", { arch: ["arm64", "x64"] }],
    ["a bad version", { version: "one" }],
    ["an --out in a Keychains folder", { out: "/Users/x/Library/Keychains/out" }],
  ])("is a usage error for %s", (_name, flags) => {
    expect(() => resolve(flags)).toThrow(UsageError);
  });

  test("accepts a pre-release version", () => {
    expect(resolve({ version: "0.4.0-rc.1" }).version).toBe("0.4.0-rc.1");
  });
});

describe("parseNotarySubmission", () => {
  test("reads the id and status", () => {
    expect(parseNotarySubmission('{"id":"abc","status":"Accepted"}')).toEqual({
      id: "abc",
      status: "Accepted",
    });
  });

  test("anything else yields nothing", () => {
    expect(parseNotarySubmission("Error: no")).toEqual({ id: undefined, status: undefined });
    expect(parseNotarySubmission("[]")).toEqual({ id: undefined, status: undefined });
  });
});

describe("keychain search list", () => {
  test("parses the quoted paths security prints", () => {
    expect(
      parseKeychainList('    "/a/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'),
    ).toEqual(["/a/login.keychain-db", "/Library/Keychains/System.keychain"]);
  });

  test("removes only our entry and reports no change when the rest is what it was", () => {
    expect(withoutKeychain(["/t", "/a", "/b"], "/t", ["/a", "/b"])).toEqual({
      list: ["/a", "/b"],
      changed: false,
    });
  });

  test("keeps what someone else added and says so", () => {
    expect(withoutKeychain(["/t", "/a", "/new"], "/t", ["/a"])).toEqual({
      list: ["/a", "/new"],
      changed: true,
    });
  });

  test("has nothing to do when our entry is not listed", () => {
    expect(withoutKeychain(["/a"], "/t", ["/a"])).toBeUndefined();
  });
});

describe("state file", () => {
  const dir = "/work/out/.signing";
  const state = {
    runId: "r1",
    pid: 12,
    keychain: join(dir, "r1.keychain-db"),
    startedAt: "now",
    searchListBefore: ["/a"],
  };

  test("round-trips", () => {
    expect(parseState(serializeState(state), dir)).toEqual(state);
  });

  test("refuses a keychain outside the signing folder, including a nested or sibling path", () => {
    for (const keychain of [
      "/Users/x/Library/Keychains/login.keychain-db",
      join(dir, "a/b.keychain-db"),
      "/work/out/.signing-x/k",
      "rel.keychain-db",
    ]) {
      expect(() => parseState(serializeState({ ...state, keychain }), dir)).toThrow(
        /directly inside|expected shape/,
      );
    }
  });

  test("refuses a file of the wrong shape", () => {
    expect(() => parseState('{"runId":1}', dir)).toThrow("expected shape");
    expect(() => parseState("[]", dir)).toThrow();
  });
});

describe("replaceUpdateFile", () => {
  const YML = `version: 0.1.0
files:
  - url: Claudebot-0.1.0-arm64-mac.zip
    sha512: ZIPHASH
    size: 100
  - url: Claudebot-0.1.0-arm64.dmg
    sha512: OLDDMGHASH
    size: 200
    blockMapSize: 5
path: Claudebot-0.1.0-arm64-mac.zip
sha512: ZIPHASH
releaseDate: '2026-01-01'
`;

  test("replaces the sha512 and size of that file only", () => {
    const out = replaceUpdateFile(YML, "Claudebot-0.1.0-arm64.dmg", {
      sha512: "NEWHASH",
      size: 321,
    });
    expect(out).toBe(YML.replace("OLDDMGHASH", "NEWHASH").replace("size: 200", "size: 321"));
  });

  test("throws when the file is not listed or its entry is incomplete", () => {
    expect(() => replaceUpdateFile(YML, "other.dmg", { sha512: "x", size: 1 })).toThrow(
      "does not list",
    );
    expect(() =>
      replaceUpdateFile("files:\n  - url: a.dmg\n    size: 1\n", "a.dmg", { sha512: "x", size: 1 }),
    ).toThrow("lacks sha512 or size");
  });
});
