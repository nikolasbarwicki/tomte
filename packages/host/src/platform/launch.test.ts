import { describe, expect, test } from "bun:test";

import { commandLine, hostCommand, serverCommand } from "./launch.ts";

describe("commands printed for the user", () => {
  test("plain words stay as they are and anything else is quoted for the shell", () => {
    expect(commandLine(["pair", "--data-root", "/data/tomte"], "linux")).toBe(
      "pair --data-root /data/tomte",
    );
    expect(commandLine(["--data-root", "/Users/Ada Lovelace/it's"], "darwin")).toBe(
      "--data-root '/Users/Ada Lovelace/it'\\''s'",
    );
  });

  test("Windows paths keep their backslashes and are double-quoted when they hold a space", () => {
    expect(commandLine(["C:\\tools\\tomte-host.exe", "pair"], "win32")).toBe(
      "C:\\tools\\tomte-host.exe pair",
    );
    expect(commandLine(["C:\\Program Files\\tomte\\host.exe"], "win32")).toBe(
      '"C:\\Program Files\\tomte\\host.exe"',
    );
  });

  test("from source, they run the repo's scripts", () => {
    expect(hostCommand("install-browser")).toBe("bun run host install-browser");
    expect(hostCommand("pair", "--data-root", "/tmp/a b")).toBe(
      "bun run host pair --data-root '/tmp/a b'",
    );
    expect(serverCommand("3f2a")).toBe("bun run ui 3f2a");
  });
});
