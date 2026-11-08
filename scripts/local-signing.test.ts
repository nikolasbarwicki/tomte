// The local signing route end to end against a recording fake of `security`, `codesign`, `notarytool` and the build:
// no keychain, certificate or Apple service is touched. The inputs are obviously synthetic bytes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CommandError, type Ran, type Runner } from "./command-runner.ts";
import { hostBinaryName } from "./desktop-kit.ts";
import {
  type LocalConfig,
  type LocalInputs,
  LOCAL_ENV,
  resolveLocalConfig,
  serializeState,
} from "./local-signing-kit.ts";
import {
  cleanupLocal,
  type Deps,
  loadSecrets,
  renderPlan,
  runLocalSigning,
} from "./local-signing.ts";
import { parseUpdateMetadata, sha512Base64 } from "./release-verify.ts";

const P12_PASSWORD = "SYNTHETIC-P12-PASSWORD-7c1f";
const KEY_ID = "SYNTHKEYID99";
const ISSUER = "00000000-synthetic-issuer-0000";
const IDENTITY = "A1B2C3D4E5F60718293A4B5C6D7E8F9011223344";
const LOGIN = "/Users/someone/Library/Keychains/login.keychain-db";

const DETAILS = `Executable=/x/Claudebot
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
Authority=Developer ID Application: Synthetic Co (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 8, 2026 at 09:00:00
TeamIdentifier=ABCDE12345
`;
const ENTITLEMENTS = `<plist><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>`;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

interface Behavior {
  /** `create-keychain` lists the new keychain first in the search list. */
  createAddsToList?: boolean;
  /** `delete-keychain` leaves the keychain in the search list (the documented behavior is that it removes it; this exercises the restore). */
  deleteLeavesInList?: boolean;
  /** Number of valid Developer ID identities `find-identity` reports. */
  identities?: number;
  notary?: "Accepted" | "Invalid";
  /** Runs before a command whose argv contains `when`. */
  before?: { when: string; run: (fake: FakeMac) => void | Promise<void> };
}

/** Plays the tools the route runs: keeps a search list, makes and deletes keychain files, builds a fake bundle. */
class FakeMac {
  calls: string[][] = [];
  envs: (Record<string, string> | undefined)[] = [];
  searchList: string[] = [LOGIN];
  hang: Promise<void> | undefined;
  readonly reached = Promise.withResolvers<void>();
  constructor(
    readonly repoRoot: string,
    readonly behavior: Behavior = {},
  ) {}

  run: Runner = async (cmd, env) => {
    this.calls.push([...cmd]);
    this.envs.push(env);
    const b = this.behavior.before;
    if (b !== undefined && cmd.includes(b.when)) await b.run(this);
    const [bin, sub] = cmd as [string, string];
    const last = cmd.at(-1) as string;
    const ok = (stdout = "", stderr = ""): Ran => ({ stdout, stderr });
    if (bin === "security") return this.security(sub, cmd, last, ok);
    if (bin === "bun") return this.bun(cmd, ok);
    if (bin === "codesign") {
      if (sub === "--sign" || cmd.includes("--sign")) {
        if (last.endsWith(".dmg")) await appendFile(last, "+signed");
        return ok();
      }
      if (sub === "-dvv") return ok("", DETAILS);
      if (sub === "-d") return ok(ENTITLEMENTS);
      return ok();
    }
    if (bin === "xcrun" && sub === "notarytool") return this.notary(cmd, ok);
    if (bin === "xcrun" && sub === "stapler" && cmd[2] === "staple") {
      await appendFile(last, "+stapled");
      return ok();
    }
    if (bin === "ditto") {
      sh(["unzip", "-q", cmd[3] as string, "-d", last], this.repoRoot);
      return ok();
    }
    return ok();
  };

  private async security(
    sub: string,
    cmd: readonly string[],
    last: string,
    ok: (a?: string, b?: string) => Ran,
  ): Promise<Ran> {
    if (sub === "list-keychains") {
      const s = cmd.indexOf("-s");
      if (s >= 0) this.searchList = cmd.slice(s + 1);
      return ok(this.searchList.map((k) => `    "${k}"`).join("\n") + "\n");
    }
    if (sub === "create-keychain") {
      await writeFile(last, "SYNTHETIC KEYCHAIN");
      if (this.behavior.createAddsToList) this.searchList = [last, ...this.searchList];
    }
    if (sub === "delete-keychain") {
      await rm(last, { force: true });
      if (!this.behavior.deleteLeavesInList) {
        this.searchList = this.searchList.filter((k) => k !== last);
      }
    }
    if (sub === "find-identity") {
      const n = this.behavior.identities ?? 1;
      const lines = Array.from(
        { length: n },
        (_, i) =>
          `  ${i + 1}) ${i === 0 ? IDENTITY : `${IDENTITY.slice(0, 38)}FF`} "Developer ID Application: Synthetic Co (ABCDE12345)"`,
      );
      return ok(`${lines.join("\n")}\n     ${n} valid identities found\n`);
    }
    return ok();
  }

  private notary(cmd: readonly string[], ok: (a?: string, b?: string) => Ran): Ran {
    if (cmd[2] === "log") return ok("SYNTHETIC NOTARY LOG: the binary is not signed");
    const status = this.behavior.notary ?? "Accepted";
    const json = JSON.stringify({ id: "sub-123", status });
    if (status !== "Accepted")
      throw new CommandError("xcrun notarytool", 1, json, "Error: rejected");
    return ok(json);
  }

  private async bun(cmd: readonly string[], ok: (a?: string, b?: string) => Ran): Promise<Ran> {
    const script = cmd[1] as string;
    if (script.endsWith("build-host.ts")) {
      const host = join(this.repoRoot, "dist/host", hostBinaryName("darwin", "arm64"));
      await mkdir(dirname(host), { recursive: true });
      await writeFile(host, "SYNTHETIC HOST BINARY");
      return ok();
    }
    if (this.hang !== undefined) {
      this.reached.resolve();
      await this.hang;
    }
    const flag = (name: string) => cmd[cmd.indexOf(name) + 1] as string;
    const out = flag("--out");
    const version = flag("--version");
    const bundle = join(out, "Claudebot-darwin-arm64");
    const app = join(bundle, "mac-arm64/Claudebot.app");
    const host = join(app, "Contents/Resources/claudebot-host");
    await mkdir(dirname(host), { recursive: true });
    await writeFile(
      host,
      await readFile(join(flag("--host-dir"), hostBinaryName("darwin", "arm64"))),
    );
    await chmod(host, 0o755);
    const dmg = join(bundle, `Claudebot-${version}-arm64.dmg`);
    const zip = join(bundle, `Claudebot-${version}-arm64-mac.zip`);
    await writeFile(dmg, "SYNTHETIC DMG");
    sh(["zip", "-q", "-r", zip, "Claudebot.app"], join(bundle, "mac-arm64"));
    await writeFile(`${dmg}.blockmap`, "SYNTHETIC BLOCKMAP");
    await writeFile(
      join(bundle, "latest-mac.yml"),
      [
        `version: ${version}`,
        "files:",
        `  - url: Claudebot-${version}-arm64-mac.zip`,
        `    sha512: ${await sha512Base64(zip)}`,
        `    size: ${(await stat(zip)).size}`,
        `  - url: Claudebot-${version}-arm64.dmg`,
        `    sha512: ${await sha512Base64(dmg)}`,
        `    size: ${(await stat(dmg)).size}`,
        `path: Claudebot-${version}-arm64-mac.zip`,
        "sha512: x",
        "",
      ].join("\n"),
    );
    return ok();
  }

  /** The commands, as `bin sub` for the keychain tools and `bin` otherwise. */
  get heads(): string[] {
    return this.calls.map((c) =>
      ["security", "xcrun"].includes(c[0]!) ? `${c[0]} ${c[1]}` : c[0]!,
    );
  }
}

let root: string;
let repoRoot: string;
let out: string;
let inputs: LocalInputs;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claudebot-local-signing-test-"));
  repoRoot = join(root, "repo");
  out = join(root, "repo/dist/rel-test");
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(root, "synthetic.p12"), "SYNTHETIC-NOT-A-REAL-P12");
  await writeFile(join(root, "synthetic.p8"), "SYNTHETIC-NOT-A-REAL-P8");
  inputs = {
    p12File: join(root, "synthetic.p12"),
    p12PasswordFile: undefined,
    p12Password: P12_PASSWORD,
    apiKeyFile: join(root, "synthetic.p8"),
    apiKeyId: KEY_ID,
    apiIssuer: ISSUER,
  };
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function configure(
  over: { confirm?: boolean; ci?: boolean; addToSearchList?: boolean; platform?: string } = {},
): Promise<LocalConfig> {
  const secrets = await loadSecrets(inputs, KEY_ID, ISSUER);
  return resolveLocalConfig({
    flags: {
      out,
      version: "0.1.0",
      arch: [],
      confirm: over.confirm ?? true,
      addToSearchList: over.addToSearchList ?? false,
    },
    inputs,
    platform: over.platform ?? "darwin",
    ci: over.ci ?? false,
    repoRoot,
    hostVersion: "0.1.0",
    runId: "run42",
    secrets,
  });
}

interface Harness {
  deps: Deps;
  logs: string[];
  warnings: string[];
  exits: number[];
  signals: (() => void)[];
  fake: FakeMac;
}

function harness(
  behavior: Behavior = {},
  running: { pid: number; command: string }[] = [],
): Harness {
  const fake = new FakeMac(repoRoot, behavior);
  const logs: string[] = [];
  const warnings: string[] = [];
  const exits: number[] = [];
  const signals: (() => void)[] = [];
  const deps: Deps = {
    run: fake.run,
    log: (l) => logs.push(l),
    warn: (l) => warnings.push(l),
    processes: () => running.map((p) => ({ ...p, ppid: 1, tty: "??" })),
    onSignal: (h) => {
      signals.push(h);
      return () => {
        signals.splice(signals.indexOf(h), 1);
      };
    },
    stopCommands: () => {
      fake.hang = undefined;
    },
    exit: (code) => exits.push(code),
  };
  return { deps, logs, warnings, exits, signals, fake };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("runLocalSigning", () => {
  test("runs the operations in order and leaves signed, verified, checksummed artifacts", async () => {
    const h = harness();
    const config = await configure();
    await runLocalSigning(config, h.deps);

    const heads = h.fake.heads;
    const order = [
      "security list-keychains", // snapshot, read only
      "bun", // build host
      "security create-keychain",
      "security set-keychain-settings",
      "security unlock-keychain",
      "security import",
      "security set-key-partition-list",
      "security find-identity",
      "codesign", // sign the host
      "codesign", // verify the host
      "bun", // package, sign, notarize the app
      "security unlock-keychain",
      "codesign", // sign the DMG
      "xcrun notarytool",
      "xcrun stapler",
    ];
    let at = -1;
    for (const head of order) {
      const next = heads.indexOf(head, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(heads.at(-1)).toBe("security list-keychains");
    expect(heads.at(-2)).toBe("security delete-keychain");

    const p = config.paths;
    const sign = h.fake.calls.find((c) => c[0] === "codesign" && c.includes("--entitlements"))!;
    expect(sign).toContain(IDENTITY);
    expect(sign).toContain(p.stagedHost);
    expect(sign.slice(sign.indexOf("--options"), sign.indexOf("--options") + 2)).toEqual([
      "--options",
      "runtime",
    ]);
    const pack = h.fake.calls.find((c) => c[1]?.endsWith("package-desktop.ts"))!;
    expect(pack).toEqual(expect.arrayContaining(["--sign", "--local-keychain", p.keychain]));
    expect(pack[pack.indexOf("--local-identity") + 1]).toBe(IDENTITY);
    const packEnv = h.fake.envs[h.fake.calls.indexOf(pack)]!;
    expect(packEnv).toEqual({
      APPLE_API_KEY: inputs.apiKeyFile as string,
      APPLE_API_KEY_ID: KEY_ID,
      APPLE_API_ISSUER: ISSUER,
    });
    expect(h.fake.calls.find((c) => c.includes("notarytool"))).toContain(p.dmg);

    // the DMG on disk is the signed and stapled one, and latest-mac.yml describes exactly that file
    expect(await readFile(p.dmg, "utf8")).toBe("SYNTHETIC DMG+signed+stapled");
    const meta = parseUpdateMetadata(await readFile(join(p.artifacts, "latest-mac.yml"), "utf8"));
    const dmgEntry = meta.files.find((f) => f.url.endsWith(".dmg"))!;
    expect(dmgEntry.sha512).toBe(await sha512Base64(p.dmg));
    expect(dmgEntry.size).toBe((await stat(p.dmg)).size);
    const sums = await readFile(join(p.artifacts, "SHA256SUMS"), "utf8");
    expect(sums).toContain("Claudebot-0.1.0-arm64.dmg");
    expect(sums).toContain("Claudebot-0.1.0-arm64-mac.zip");
    expect(sums).toContain("latest-mac.yml");

    // nothing of the run's keychain is left
    expect(await exists(p.signingDir)).toBe(false);
    expect(h.fake.searchList).toEqual([LOGIN]);
  });

  test("only ever touches the temporary keychain: no search-list rewrite, default keychain or login keychain", async () => {
    const h = harness();
    const config = await configure();
    await runLocalSigning(config, h.deps);
    const security = h.fake.calls.filter((c) => c[0] === "security");
    for (const call of security) {
      expect(call).not.toContain("default-keychain");
      expect(call.join(" ")).not.toContain("Library/Keychains");
      expect(call).not.toContain("system");
      if (call[1] === "list-keychains") expect(call).not.toContain("-s");
    }
    const withKeychain = h.fake.calls.filter(
      (c) => c.includes("--keychain") || c[0] === "security",
    );
    for (const call of withKeychain) {
      const paths = call.filter((a) => a.endsWith(".keychain-db"));
      for (const path of paths) expect(path).toBe(config.paths.keychain);
    }
    expect(config.paths.keychain.startsWith(join(out, ".signing"))).toBe(true);
    expect(security.some((c) => c[1] === "list-keychains" && c.includes("-s"))).toBe(false);
  });

  test("a keychain that create-keychain put in the search list is removed again, others untouched", async () => {
    const h = harness({ createAddsToList: true, deleteLeavesInList: true });
    await runLocalSigning(await configure(), h.deps);
    expect(h.fake.searchList).toEqual([LOGIN]);
    expect(h.warnings).toEqual([]);
  });

  test("--add-to-search-list puts the temporary keychain first, then removes only it", async () => {
    const h = harness();
    const config = await configure({ addToSearchList: true });
    await runLocalSigning(config, h.deps);
    const prepend = h.fake.calls.find((c) => c[1] === "list-keychains" && c.includes("-s"))!;
    expect(prepend.slice(prepend.indexOf("-s") + 1)).toEqual([config.paths.keychain, LOGIN]);
    expect(h.fake.searchList).toEqual([LOGIN]);
  });

  test("a search-list change made by someone else during the run is kept and reported", async () => {
    const other = "/Users/someone/Library/Keychains/added-meanwhile.keychain-db";
    const h = harness({
      deleteLeavesInList: true,
      before: {
        when: "notarytool",
        run: (fake) => {
          fake.searchList = [...fake.searchList, other];
        },
      },
    });
    await runLocalSigning(await configure({ addToSearchList: true }), h.deps);
    expect(h.fake.searchList).toEqual([LOGIN, other]);
    expect(h.warnings.join("\n")).toContain("changed while signing");
  });

  test("cleans up when a step fails, and says what to do when no valid identity is found", async () => {
    const h = harness({ identities: 0 });
    const config = await configure();
    await expect(runLocalSigning(config, h.deps)).rejects.toThrow(/--add-to-search-list/);
    expect(h.fake.heads).toContain("security delete-keychain");
    expect(await exists(config.paths.signingDir)).toBe(false);
    expect(h.fake.heads).not.toContain("xcrun notarytool");
  });

  test("two identities are refused rather than guessed", async () => {
    const h = harness({ identities: 2 });
    const config = await configure();
    await expect(runLocalSigning(config, h.deps)).rejects.toThrow(/exactly one|2/);
    expect(h.fake.calls.some((c) => c[0] === "codesign")).toBe(false);
    expect(await exists(config.paths.signingDir)).toBe(false);
  });

  test("a rejected notarization fails with Apple's log, cleans up and never staples or writes artifacts", async () => {
    const h = harness({ notary: "Invalid" });
    const config = await configure();
    await expect(runLocalSigning(config, h.deps)).rejects.toThrow(/SYNTHETIC NOTARY LOG/);
    expect(h.fake.calls.some((c) => c[1] === "stapler")).toBe(false);
    expect(await exists(config.paths.artifacts)).toBe(false);
    expect(await exists(config.paths.signingDir)).toBe(false);
  });

  test("on SIGTERM it stops the running command, deletes the keychain and exits 130", async () => {
    const h = harness();
    const { promise, resolve } = Promise.withResolvers<void>();
    h.fake.hang = promise;
    const config = await configure();
    const started = runLocalSigning(config, h.deps);
    // wait until the packaging step is blocked
    await h.fake.reached.promise;
    h.deps.stopCommands = () => resolve();
    expect(h.signals).toHaveLength(1);
    h.signals[0]!();
    await expect(started).rejects.toThrow("interrupted");
    expect(h.fake.heads).toContain("security delete-keychain");
    expect(await exists(config.paths.signingDir)).toBe(false);
    expect(h.exits).toEqual([130]);
    expect(h.signals).toHaveLength(0);
  });

  test("a secret value is in no log line, warning or error", async () => {
    const h = harness({ notary: "Invalid" });
    const config = await configure();
    const error = await runLocalSigning(config, h.deps).catch((e: Error) => e);
    const text = [...h.logs, ...h.warnings, String((error as Error).message)].join("\n");
    for (const secret of [P12_PASSWORD, KEY_ID, ISSUER, config.secrets.keychainPassword.value]) {
      expect(text).not.toContain(secret);
    }
  });

  describe("refuses before any command", () => {
    async function refused(config: LocalConfig, h: Harness, pattern: RegExp): Promise<void> {
      await expect(runLocalSigning(config, h.deps)).rejects.toThrow(pattern);
      expect(h.fake.calls).toEqual([]);
      expect(await exists(config.paths.signingDir)).toBe(false);
    }

    test("in CI", async () => {
      await refused(await configure({ ci: true }), harness(), /CI/);
    });

    test("without the confirmation flag", async () => {
      await refused(
        await configure({ confirm: false }),
        harness(),
        /--confirm-keychain-and-notary-upload/,
      );
    });

    test("when the input names no file", async () => {
      await rm(inputs.p12File as string);
      await refused(await configure(), harness(), /CLAUDEBOT_LOCAL_P12_FILE does not name a file/);
    });

    test("into a folder that is not empty", async () => {
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "something"), "x");
      await refused(await configure(), harness(), /not empty/);
    });

    test("while a process runs from the staging folder", async () => {
      const h = harness({}, [{ pid: 4242, command: `${out}/Claudebot-darwin-arm64/x/Claudebot` }]);
      await refused(await configure(), h, /4242|running process/);
    });
  });
});

describe("plan", () => {
  test("shows every operation, never a secret value, and is the same twice", async () => {
    const config = await configure();
    const text = renderPlan(config);
    for (const secret of [P12_PASSWORD, KEY_ID, ISSUER, config.secrets.keychainPassword.value]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("<p12-password>");
    expect(text).toContain("<keychain-password>");
    expect(text).toContain("<api-key-id>");
    expect(text).toContain("<api-issuer>");
    for (const word of [
      "security create-keychain",
      "security import",
      "security find-identity",
      "codesign --force --options runtime",
      "package-desktop.ts --sign",
      "xcrun notarytool submit",
      "xcrun stapler staple",
      "security delete-keychain",
      "Uploaded to Apple",
    ]) {
      expect(text).toContain(word);
    }
    expect(text).not.toContain("list-keychains -d user -s /");
    expect(renderPlan(config)).toBe(text);
  });

  test("lists the search-list prepend only when it is opted in", async () => {
    const without = renderPlan(await configure());
    const withFlag = renderPlan(await configure({ addToSearchList: true }));
    expect(without).not.toContain("Put the temporary keychain first");
    expect(withFlag).toContain("Put the temporary keychain first");
  });

  test("says what would make a run refuse, and still plans", async () => {
    const text = renderPlan(await configure({ confirm: false, ci: true }));
    expect(text).toContain("Run refuses now because");
    expect(text).toContain("--confirm-keychain-and-notary-upload was not given");
    expect(text).toContain("security create-keychain");
  });

  test("names the environment variables, not their values", async () => {
    const text = renderPlan(await configure());
    expect(text).toContain(LOCAL_ENV.apiKeyId);
    expect(text).toContain("<set, not shown>");
  });
});

describe("cleanupLocal", () => {
  async function crashedRun(): Promise<{ config: LocalConfig; h: Harness }> {
    const h = harness();
    const config = await configure();
    const p = config.paths;
    await mkdir(p.signingDir, { recursive: true });
    await writeFile(p.keychain, "SYNTHETIC KEYCHAIN");
    await writeFile(
      p.state,
      serializeState({
        runId: "run42",
        pid: 1,
        keychain: p.keychain,
        startedAt: "then",
        searchListBefore: [LOGIN],
      }),
    );
    h.fake.searchList = [p.keychain, LOGIN];
    return { config, h };
  }

  test("deletes what a killed run left and restores the search list, twice safely", async () => {
    const { config, h } = await crashedRun();
    await cleanupLocal(out, h.deps);
    expect(await exists(config.paths.signingDir)).toBe(false);
    expect(h.fake.searchList).toEqual([LOGIN]);
    expect(
      h.fake.calls.some((c) => c[1] === "delete-keychain" && c.at(-1) === config.paths.keychain),
    ).toBe(true);
    const before = h.fake.calls.length;
    await cleanupLocal(out, h.deps);
    expect(h.fake.calls.length).toBe(before);
    expect(h.logs.at(-1)).toContain("nothing to clean up");
  });

  test("a state file that names a keychain outside the signing folder is refused", async () => {
    const { config, h } = await crashedRun();
    await writeFile(
      config.paths.state,
      serializeState({
        runId: "run42",
        pid: 1,
        keychain: LOGIN,
        startedAt: "then",
        searchListBefore: [LOGIN],
      }),
    );
    await expect(cleanupLocal(out, h.deps)).rejects.toThrow(/not directly inside/);
    expect(h.fake.calls).toEqual([]);
  });

  test("without a state file it deletes the keychains in the folder and leaves the search list alone", async () => {
    const { config, h } = await crashedRun();
    await rm(config.paths.state);
    await cleanupLocal(out, h.deps);
    expect(h.warnings.join("\n")).toContain("search list untouched");
    expect(h.fake.calls.some((c) => c[1] === "list-keychains")).toBe(false);
    expect(await exists(config.paths.signingDir)).toBe(false);
  });
});
