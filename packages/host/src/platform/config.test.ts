import { describe, expect, test } from "bun:test";

import {
  agentOrigin,
  clientOrigin,
  InvalidConfig,
  parseHostConfig,
  type HostSystem,
} from "./config.ts";

const parse = (
  argv: readonly string[] = [],
  env: Record<string, string | undefined> = {},
  system: HostSystem = { platform: "linux", home: "/home/ada" },
) => parseHostConfig(argv, env, system);

const KEY_FILE = "/srv/claudebot/secrets.key";

describe("defaults", () => {
  test.each([
    { name: "local mode by default", argv: [], mode: "local", port: 0 },
    { name: "local mode picks a free port", argv: ["--mode", "local"], mode: "local", port: 0 },
    {
      name: "remote mode binds loopback on a free port",
      argv: ["--mode", "remote", "--secrets-key-file", KEY_FILE],
      mode: "remote",
      port: 0,
    },
    {
      name: "the dev script's flags",
      argv: ["--port", "5173", "--vite"],
      mode: "local",
      port: 5173,
    },
  ])("$name", ({ argv, mode, port }) => {
    const { config } = parse(argv);
    expect(config.mode).toBe(mode as "local" | "remote");
    expect(config.bind).toEqual({ address: "127.0.0.1", port });
  });

  test.each([
    ["local", []],
    ["remote", ["--secrets-key-file", KEY_FILE]],
  ])("%s mode serves no Vite unless asked", (mode, extra) => {
    const { config } = parse(["--mode", mode, ...extra]);
    expect(config.vite).toBe(false);
  });

  test("local mode keeps secrets in the keychain, allows headed Chrome and reveal, and isolates only browser bots", () => {
    const { config } = parse(["--mode", "local"]);
    expect(config.secrets).toEqual({ backend: "keychain" });
    expect(config.headedBrowser).toBe(true);
    expect(config.reveal).toBe(true);
    expect(config.isolateAllBots).toBe(false);
    expect(config.allowPlainHttp).toBe(false);
  });

  test("remote mode keeps secrets in a file, runs headless without reveal, and isolates every bot", () => {
    const { config } = parse(["--mode", "remote", "--secrets-key-file", KEY_FILE]);
    expect(config.secrets).toEqual({ backend: "file", keyFile: KEY_FILE });
    expect(config.headedBrowser).toBe(false);
    expect(config.reveal).toBe(false);
    expect(config.isolateAllBots).toBe(true);
    expect(config.allowPlainHttp).toBe(false);
  });

  test("the dev script's flags turn Vite on", () => {
    const { config } = parse(["--port", "5173", "--vite"]);
    expect(config.vite).toBe(true);
  });

  test("the public URL defaults to the loopback URL of the bound port", () => {
    const { config } = parse();
    expect(clientOrigin(config, 41234).publicUrl).toBe("http://127.0.0.1:41234");
    expect(clientOrigin(config, 41234).localUrl).toBe("http://127.0.0.1:41234");
  });
});

describe("flags and environment", () => {
  test("environment variables set every field", () => {
    const { config } = parse([], {
      CLAUDEBOT_MODE: "remote",
      CLAUDEBOT_HOST: "::1",
      CLAUDEBOT_PORT: "8080",
      CLAUDEBOT_PUBLIC_URL: "https://claudebot.example.com",
      CLAUDEBOT_ALLOW_PLAIN_HTTP: "1",
      CLAUDEBOT_SECRETS: "file",
      CLAUDEBOT_SECRETS_KEY_FILE: KEY_FILE,
      CLAUDEBOT_ASK_APPROVAL: "1",
      CLAUDEBOT_VITE: "true",
      CLAUDEBOT_DATA_ROOT: "/srv/claudebot",
      CLAUDEBOT_RELAY_CONFIG: "/etc/claudebot/relay.json",
      CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS: "14",
    });
    expect(config).toEqual({
      mode: "remote",
      bind: { address: "::1", port: 8080 },
      publicUrl: "https://claudebot.example.com",
      allowPlainHttp: true,
      secrets: { backend: "file", keyFile: KEY_FILE },
      headedBrowser: false,
      reveal: false,
      isolateAllBots: true,
      sidecar: false,
      pauseAfterAbsenceDays: 14,
      vite: true,
      askApproval: true,
      dataRoot: "/srv/claudebot",
      relayConfig: "/etc/claudebot/relay.json",
    });
  });

  test("a flag wins over the environment", () => {
    const { config } = parse(["--port", "9000", "--mode", "local"], {
      CLAUDEBOT_PORT: "8080",
      CLAUDEBOT_MODE: "remote",
    });
    expect(config.mode).toBe("local");
    expect(config.bind.port).toBe(9000);
  });

  test("an environment variable can switch Vite off", () => {
    const { config } = parse([], { CLAUDEBOT_VITE: "false" });
    expect(config.vite).toBe(false);
  });

  test("the absence pause is off unless a flag or the environment sets a number of days, and a flag wins", () => {
    expect(parse().config.pauseAfterAbsenceDays).toBe(0);
    expect(
      parse([], { CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS: "14" }).config.pauseAfterAbsenceDays,
    ).toBe(14);
    expect(
      parse(["--pause-after-absence-days", "7"], { CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS: "14" })
        .config.pauseAfterAbsenceDays,
    ).toBe(7);
    expect(
      parse(["--pause-after-absence-days", "0"], { CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS: "14" })
        .config.pauseAfterAbsenceDays,
    ).toBe(0);
  });

  test.each([["-1"], ["1.5"], ["two"], ["1e3"], ["0x10"]])("rejects %s days of absence", (days) => {
    expect(() => parse(["--pause-after-absence-days", days])).toThrow(InvalidConfig);
    expect(() => parse([], { CLAUDEBOT_PAUSE_AFTER_ABSENCE_DAYS: days })).toThrow(InvalidConfig);
  });

  test("the relay configuration is relay.json in the data root unless a flag or the environment names another", () => {
    expect(parse(["--data-root", "/srv/c"]).config.relayConfig).toBe("/srv/c/relay.json");
    expect(
      parse(["--relay-config", "/etc/r.json"], { CLAUDEBOT_RELAY_CONFIG: "/x.json" }).config
        .relayConfig,
    ).toBe("/etc/r.json");
  });

  test("a relay configuration path must be absolute", () => {
    expect(() => parse(["--relay-config", "relay.json"])).toThrow(/absolute path/);
  });

  test("empty environment variables count as unset", () => {
    const { config } = parse([], { CLAUDEBOT_PORT: "", CLAUDEBOT_HOST: "", CLAUDEBOT_MODE: "" });
    expect(config.bind).toEqual({ address: "127.0.0.1", port: 0 });
  });

  test("arguments that are not flags come back in order", () => {
    const { positionals, config } = parse(["/work", "--port", "5173", "bot-1"]);
    expect(positionals).toEqual(["/work", "bot-1"]);
    expect(config.bind.port).toBe(5173);
  });

  test("a trailing slash on the public URL is dropped", () => {
    expect(parse(["--public-url", "https://claudebot.example.com/"]).config.publicUrl).toBe(
      "https://claudebot.example.com",
    );
  });
});

describe("data root", () => {
  const linux: HostSystem = { platform: "linux", home: "/home/ada" };
  test.each([
    {
      name: "macOS uses Application Support",
      system: { platform: "darwin", home: "/Users/ada" },
      env: {},
      expected: "/Users/ada/Library/Application Support/claudebot",
    },
    {
      name: "Linux uses ~/.local/share",
      system: { platform: "linux", home: "/home/ada" },
      env: {},
      expected: "/home/ada/.local/share/claudebot",
    },
    {
      name: "Linux follows XDG_DATA_HOME",
      system: { platform: "linux", home: "/home/ada" },
      env: { XDG_DATA_HOME: "/data/xdg" },
      expected: "/data/xdg/claudebot",
    },
    {
      name: "Linux ignores a relative XDG_DATA_HOME",
      system: { platform: "linux", home: "/home/ada" },
      env: { XDG_DATA_HOME: "xdg" },
      expected: "/home/ada/.local/share/claudebot",
    },
    {
      name: "Windows uses APPDATA",
      system: { platform: "win32", home: "C:\\Users\\ada" },
      env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
      expected: "C:\\Users\\ada\\AppData\\Roaming\\claudebot",
    },
  ] as const)("default: $name", ({ system, env, expected }) => {
    const root = parse([], env, system).config.dataRoot;
    expect(root.replaceAll("\\", "/")).toBe(expected.replaceAll("\\", "/"));
  });

  test("remote mode has the same default as local mode", () => {
    expect(
      parse(["--mode", "remote", "--secrets-key-file", KEY_FILE], {}, linux).config.dataRoot,
    ).toBe(parse([], {}, linux).config.dataRoot);
  });

  test("an environment variable overrides the default", () => {
    expect(parse([], { CLAUDEBOT_DATA_ROOT: "/srv/claudebot" }).config.dataRoot).toBe(
      "/srv/claudebot",
    );
  });

  test("a flag overrides the environment variable", () => {
    expect(
      parse(["--data-root", "/tmp/flag"], { CLAUDEBOT_DATA_ROOT: "/srv/claudebot" }).config
        .dataRoot,
    ).toBe("/tmp/flag");
  });

  test("an empty environment variable counts as unset", () => {
    expect(parse([], { CLAUDEBOT_DATA_ROOT: "" }, linux).config.dataRoot).toBe(
      "/home/ada/.local/share/claudebot",
    );
  });
});

describe("binding beyond loopback", () => {
  const URL_HTTPS = "https://claudebot.example.com";
  const URL_HTTP = "http://100.64.0.7:8080";

  test.each([
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "10.0.0.5",
    "8.8.8.8",
    "claudebot.example.com",
    "128.0.0.1",
  ])(
    "rejects binding %s with no public URL and no flag, names it, and names both ways out",
    (address) => {
      expect(() => parse(["--host", address])).toThrow(InvalidConfig);
      expect(() => parse(["--host", address])).toThrow(address);
      expect(() => parse(["--host", address])).toThrow("--public-url");
      expect(() => parse(["--host", address])).toThrow("--allow-plain-http");
    },
  );

  test("rejects a non-loopback bind from the environment", () => {
    expect(() => parse([], { CLAUDEBOT_HOST: "0.0.0.0" })).toThrow("0.0.0.0");
  });

  test("remote mode rejects it too", () => {
    expect(() =>
      parse(["--mode", "remote", "--secrets-key-file", KEY_FILE, "--host", "203.0.113.7"]),
    ).toThrow("203.0.113.7");
  });

  test("rejects a non-loopback bind with an HTTP public URL and no flag", () => {
    expect(() => parse(["--host", "0.0.0.0", "--public-url", URL_HTTP])).toThrow(
      "--allow-plain-http",
    );
  });

  test.each([
    { name: "an HTTPS public URL", argv: ["--public-url", URL_HTTPS], env: {} },
    {
      name: "an HTTPS public URL from the environment",
      argv: [],
      env: { CLAUDEBOT_PUBLIC_URL: URL_HTTPS },
    },
    { name: "--allow-plain-http", argv: ["--allow-plain-http"], env: {} },
    {
      name: "--allow-plain-http and an HTTP public URL",
      argv: ["--allow-plain-http", "--public-url", URL_HTTP],
      env: {},
    },
    { name: "CLAUDEBOT_ALLOW_PLAIN_HTTP", argv: [], env: { CLAUDEBOT_ALLOW_PLAIN_HTTP: "1" } },
  ])("accepts binding 0.0.0.0 with $name", ({ argv, env }) => {
    expect(parse(["--host", "0.0.0.0", ...argv], env).config.bind.address).toBe("0.0.0.0");
  });

  test("the plain-HTTP flag is off unless set, and the environment can switch it off", () => {
    expect(parse().config.allowPlainHttp).toBe(false);
    expect(parse(["--allow-plain-http"]).config.allowPlainHttp).toBe(true);
    expect(parse([], { CLAUDEBOT_ALLOW_PLAIN_HTTP: "0" }).config.allowPlainHttp).toBe(false);
  });

  test("an HTTP public URL on a loopback bind needs no flag", () => {
    expect(parse(["--public-url", URL_HTTP]).config.publicUrl).toBe(URL_HTTP);
  });
});

describe("loopback binds", () => {
  test.each([
    ["127.0.0.1", "127.0.0.1"],
    ["127.8.9.10", "127.8.9.10"],
    ["localhost", "localhost"],
    ["::1", "::1"],
    ["[::1]", "::1"],
  ])("accepts binding %s", (input, address) => {
    expect(parse(["--host", input]).config.bind.address).toBe(address);
  });

  test("an IPv6 loopback address is bracketed in the local URL and named by the Host header in that form", () => {
    const origin = clientOrigin(parse(["--host", "::1"]).config, 5173);
    expect(origin.localUrl).toBe("http://[::1]:5173");
    expect(origin.namesHost("[::1]:5173")).toBe(true);
  });
});

describe("invalid input", () => {
  test.each([
    { argv: ["--port", "70000"], message: "70000" },
    { argv: ["--port=-1"], message: "-1" },
    { argv: ["--port", "80x"], message: "80x" },
    { argv: ["--mode", "cloud"], message: "cloud" },
    { argv: ["--public-url", "claudebot.example.com"], message: "claudebot.example.com" },
    {
      argv: ["--public-url", "ftp://claudebot.example.com"],
      message: "ftp://claudebot.example.com",
    },
    {
      argv: ["--public-url", "https://claudebot.example.com/app"],
      message: "https://claudebot.example.com/app",
    },
    {
      argv: ["--public-url", "https://user:pw@claudebot.example.com"],
      message: "invalid public URL",
    },
    { argv: ["--bogus"], message: "bogus" },
    { argv: ["--data-root", "state"], message: "absolute path" },
    { argv: ["--data-root", ""], message: "absolute path" },
  ])("rejects $argv", ({ argv, message }) => {
    expect(() => parse(argv)).toThrow(InvalidConfig);
    expect(() => parse(argv)).toThrow(message);
  });

  test.each([["CLAUDEBOT_VITE"], ["CLAUDEBOT_ASK_APPROVAL"], ["CLAUDEBOT_ALLOW_PLAIN_HTTP"]])(
    "rejects %s set to a value that is not 1, true, 0 or false",
    (name) => {
      expect(() => parse([], { [name]: "yes" })).toThrow(InvalidConfig);
      expect(() => parse([], { [name]: "yes" })).toThrow(name);
    },
  );

  test("tool approval is off unless CLAUDEBOT_ASK_APPROVAL turns it on", () => {
    expect(parse().config.askApproval).toBe(false);
    expect(parse([], { CLAUDEBOT_ASK_APPROVAL: "true" }).config.askApproval).toBe(true);
  });

  test("the error for a public URL does not echo a password", () => {
    expect(() => parse(["--public-url", "https://user:hunter2@claudebot.example.com"])).not.toThrow(
      "hunter2",
    );
  });
});

describe("remote mode platform", () => {
  const argv = ["--mode", "remote", "--secrets-key-file", KEY_FILE];

  test("is refused on macOS, naming Linux and the keychain", () => {
    const system: HostSystem = { platform: "darwin", home: "/Users/ada" };
    expect(() => parse(argv, {}, system)).toThrow(InvalidConfig);
    expect(() => parse(argv, {}, system)).toThrow("Linux only");
    expect(() => parse(argv, {}, system)).toThrow("keychain");
    expect(() =>
      parse([], { CLAUDEBOT_MODE: "remote", CLAUDEBOT_SECRETS_KEY_FILE: KEY_FILE }, system),
    ).toThrow("Linux only");
  });

  test("is refused on Windows, naming Linux", () => {
    const system: HostSystem = { platform: "win32", home: "C:\\Users\\ada" };
    expect(() => parse(argv, {}, system)).toThrow(InvalidConfig);
    expect(() => parse(argv, {}, system)).toThrow("Linux only");
  });

  test("parses on Linux", () => {
    expect(parse(argv, {}, { platform: "linux", home: "/home/ada" }).config.mode).toBe("remote");
  });

  test.each(["darwin", "win32", "linux"] as const)("local mode parses on %s", (platform) => {
    expect(parse([], {}, { platform, home: "/home/ada" }).config.mode).toBe("local");
  });
});

describe("secrets backend", () => {
  test("a bare remote mode is rejected: its default backend is a file and it has no key file", () => {
    expect(() => parse(["--mode", "remote"])).toThrow(InvalidConfig);
    expect(() => parse(["--mode", "remote"])).toThrow("--secrets-key-file");
  });

  test.each([
    { argv: ["--secrets", "file"], message: "--secrets-key-file" },
    {
      argv: ["--secrets", "file", "--secrets-key-file", "keys/secrets.key"],
      message: "absolute path",
    },
    { argv: ["--secrets", "file", "--secrets-key-file", ""], message: "absolute path" },
    { argv: ["--secrets", "vault"], message: "vault" },
    { argv: ["--secrets-key-file", KEY_FILE], message: "keychain" },
    { argv: ["--secrets", "keychain", "--secrets-key-file", KEY_FILE], message: "keychain" },
    {
      argv: ["--mode", "remote", "--secrets", "keychain", "--secrets-key-file", KEY_FILE],
      message: "keychain",
    },
  ])("rejects $argv", ({ argv, message }) => {
    expect(() => parse(argv)).toThrow(InvalidConfig);
    expect(() => parse(argv)).toThrow(message);
  });

  test.each([
    {
      name: "local mode can opt into the file backend",
      argv: ["--secrets", "file", "--secrets-key-file", KEY_FILE],
      secrets: { backend: "file", keyFile: KEY_FILE },
    },
    {
      name: "remote mode can opt into the keychain",
      argv: ["--mode", "remote", "--secrets", "keychain"],
      secrets: { backend: "keychain" },
    },
  ])("$name", ({ argv, secrets }) => {
    expect(parse(argv).config.secrets).toEqual(secrets);
  });

  test("the environment names the backend and the key file, and a flag wins", () => {
    const env = { CLAUDEBOT_SECRETS: "file", CLAUDEBOT_SECRETS_KEY_FILE: KEY_FILE };
    expect(parse([], env).config.secrets).toEqual({ backend: "file", keyFile: KEY_FILE });
    expect(parse(["--secrets-key-file", "/other/key"], env).config.secrets).toEqual({
      backend: "file",
      keyFile: "/other/key",
    });
  });

  test("an empty key file variable counts as unset", () => {
    expect(parse([], { CLAUDEBOT_SECRETS_KEY_FILE: "" }).config.secrets).toEqual({
      backend: "keychain",
    });
  });
});

describe("the agent listener's origin", () => {
  test("is always loopback and never the public URL", () => {
    const { config } = parse(["--public-url", "https://claudebot.example.com"]);
    expect(clientOrigin(config, 5173).publicUrl).toBe("https://claudebot.example.com");
    const origin = agentOrigin(6000);
    expect(origin.localUrl).toBe("http://127.0.0.1:6000");
    expect(origin.publicUrl).toBe("http://127.0.0.1:6000");
    expect(origin.namesHost("127.0.0.1:6000")).toBe(true);
    expect(origin.namesHost("127.0.0.1:5173")).toBe(false);
  });
});

describe("which Host headers name the host", () => {
  const origin = clientOrigin(parse().config, 5173);

  test.each([
    ["127.0.0.1:5173", true],
    ["localhost:5173", true],
    ["127.0.0.1:5174", false],
    ["localhost", false],
    ["evil.example:5173", false],
    [undefined, false],
  ])("%s", (header, named) => {
    expect(origin.namesHost(header)).toBe(named);
  });
});

describe("sidecar mode", () => {
  test("is off unless --sidecar is passed, and is not read from the environment", () => {
    expect(parse().config.sidecar).toBe(false);
    expect(parse([], { CLAUDEBOT_SIDECAR: "1" }).config.sidecar).toBe(false);
    expect(parse(["--sidecar"]).config.sidecar).toBe(true);
  });

  test("is refused in remote mode, which still parses on Linux without it", () => {
    const linux: HostSystem = { platform: "linux", home: "/home/ada" };
    const remote = ["--mode", "remote", "--secrets-key-file", KEY_FILE];
    expect(() => parse([...remote, "--sidecar"], {}, linux)).toThrow(InvalidConfig);
    expect(() => parse([...remote, "--sidecar"], {}, linux)).toThrow("remote mode");
    expect(parse(remote, {}, linux).config.sidecar).toBe(false);
  });

  test("on macOS, remote mode is refused for its platform before the sidecar flag is considered", () => {
    const mac: HostSystem = { platform: "darwin", home: "/Users/ada" };
    const argv = ["--mode", "remote", "--secrets-key-file", KEY_FILE, "--sidecar"];
    expect(() => parse(argv, {}, mac)).toThrow("Linux only");
  });
});
