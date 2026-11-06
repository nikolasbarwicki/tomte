import { describe, expect, test } from "bun:test";

import { hostOrigin, InvalidConfig, parseHostConfig, type HostSystem } from "./config.ts";

const parse = (
  argv: readonly string[] = [],
  env: Record<string, string | undefined> = {},
  system?: HostSystem,
) => parseHostConfig(argv, env, system);

describe("defaults", () => {
  test.each([
    { name: "local mode by default", argv: [], mode: "local", port: 0 },
    { name: "local mode picks a free port", argv: ["--mode", "local"], mode: "local", port: 0 },
    {
      name: "remote mode binds loopback on a free port until the remote mode spec says otherwise",
      argv: ["--mode", "remote"],
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

  test.each([["local"], ["remote"]])(
    "%s mode serves no Vite and watches no herdr unless asked",
    (mode) => {
      const { config } = parse(["--mode", mode]);
      expect(config.vite).toBe(false);
      expect(config.herdr).toBe(false);
    },
  );

  test("the dev script's flags turn Vite on and leave herdr off", () => {
    const { config } = parse(["--port", "5173", "--vite"]);
    expect(config.vite).toBe(true);
    expect(config.herdr).toBe(false);
  });

  test("--herdr turns herdr on", () => {
    expect(parse(["--herdr"]).config.herdr).toBe(true);
  });

  test("the public URL defaults to the loopback URL of the bound port", () => {
    const { config } = parse();
    expect(hostOrigin(config, 41234).publicUrl).toBe("http://127.0.0.1:41234");
    expect(hostOrigin(config, 41234).localUrl).toBe("http://127.0.0.1:41234");
  });
});

describe("flags and environment", () => {
  test("environment variables set every field", () => {
    const { config } = parse([], {
      CLAUDEBOT_MODE: "remote",
      CLAUDEBOT_HOST: "::1",
      CLAUDEBOT_PORT: "8080",
      CLAUDEBOT_PUBLIC_URL: "https://claudebot.example.com",
      CLAUDEBOT_HERDR: "1",
      CLAUDEBOT_VITE: "true",
      CLAUDEBOT_DATA_ROOT: "/srv/claudebot",
    });
    expect(config).toEqual({
      mode: "remote",
      bind: { address: "::1", port: 8080 },
      publicUrl: "https://claudebot.example.com",
      herdr: true,
      vite: true,
      dataRoot: "/srv/claudebot",
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

  test("an environment variable can switch herdr and Vite off", () => {
    const { config } = parse([], { CLAUDEBOT_HERDR: "0", CLAUDEBOT_VITE: "false" });
    expect(config.herdr).toBe(false);
    expect(config.vite).toBe(false);
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
    expect(parse(["--mode", "remote"], {}, linux).config.dataRoot).toBe(
      parse([], {}, linux).config.dataRoot,
    );
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

describe("loopback only", () => {
  test.each([
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "10.0.0.5",
    "8.8.8.8",
    "claudebot.example.com",
    "128.0.0.1",
  ])("rejects binding %s and names it", (address) => {
    expect(() => parse(["--host", address])).toThrow(InvalidConfig);
    expect(() => parse(["--host", address])).toThrow(address);
  });

  test("rejects a non-loopback bind from the environment", () => {
    expect(() => parse([], { CLAUDEBOT_HOST: "0.0.0.0" })).toThrow("0.0.0.0");
  });

  test("remote mode rejects it too", () => {
    expect(() => parse(["--mode", "remote", "--host", "203.0.113.7"])).toThrow("203.0.113.7");
  });

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
    const origin = hostOrigin(parse(["--host", "::1"]).config, 5173);
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

  test("rejects a boolean environment variable that is not 1, true, 0 or false", () => {
    expect(() => parse([], { CLAUDEBOT_HERDR: "yes" })).toThrow("CLAUDEBOT_HERDR");
  });

  test("the error for a public URL does not echo a password", () => {
    expect(() => parse(["--public-url", "https://user:hunter2@claudebot.example.com"])).not.toThrow(
      "hunter2",
    );
  });
});

describe("which Host headers name the host", () => {
  const origin = hostOrigin(parse().config, 5173);

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
