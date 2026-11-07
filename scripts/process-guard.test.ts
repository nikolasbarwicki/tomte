import { describe, expect, test } from "bun:test";

import { outsideLineage, parseProcessTable, processesUnder, refusal } from "./process-guard.ts";

const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, tty: "??", command });
const BUNDLE = "/work/a/dist/desktop/Claudebot-darwin-arm64";

describe("parseProcessTable", () => {
  test("reads pid, ppid, tty and the whole command line, skipping blank lines", () => {
    const rows = parseProcessTable(
      "  101     1 ??         /a b/Claudebot --flag x\n\n 7 101 ttys001  ps -axo pid=\n",
    );
    expect(rows).toEqual([
      { pid: 101, ppid: 1, tty: "??", command: "/a b/Claudebot --flag x" },
      { pid: 7, ppid: 101, tty: "ttys001", command: "ps -axo pid=" },
    ]);
  });
});

describe("processesUnder", () => {
  const rows = [
    row(1, 0, `${BUNDLE}/Claudebot.app/Contents/MacOS/Claudebot`),
    row(
      2,
      1,
      `${BUNDLE}/Claudebot.app/Contents/Frameworks/Claudebot Helper (GPU).app/x --type=gpu`,
    ),
    row(3, 1, `open ${BUNDLE}`),
    row(4, 0, `${BUNDLE}-2/Claudebot.app/Contents/MacOS/Claudebot`),
    row(5, 0, `/work/b${BUNDLE}/Claudebot.app/Contents/MacOS/Claudebot`),
    row(6, 0, "/usr/bin/vim notes.txt"),
  ];

  test("matches the bundle's executable, its helpers and the bundle named on its own, not the same tail under another root", () => {
    expect(processesUnder(BUNDLE, rows).map((p) => p.pid)).toEqual([1, 2, 3]);
  });

  test("ignores a sibling that only shares the prefix, and a trailing slash", () => {
    expect(processesUnder(`${BUNDLE}-2/`, rows).map((p) => p.pid)).toEqual([4]);
  });

  test("treats regex characters in the path literally", () => {
    expect(
      processesUnder("/work/a+b", [row(1, 0, "/work/a+b/app"), row(2, 0, "/work/aab/app")]),
    ).toEqual([row(1, 0, "/work/a+b/app")]);
  });
});

describe("outsideLineage", () => {
  test("drops the process, its parents and their parents, and keeps the rest", () => {
    const rows = [
      row(1, 0, "launchd"),
      row(10, 1, "bun run smoke"),
      row(11, 10, "bun smoke.ts"),
      row(12, 1, "app"),
    ];
    expect(outsideLineage(rows, 11).map((p) => p.pid)).toEqual([12]);
  });

  test("stops at a parent that is not in the table or loops back", () => {
    expect(outsideLineage([row(5, 99, "a"), row(6, 5, "b")], 6)).toEqual([]);
    expect(
      outsideLineage([row(5, 6, "a"), row(6, 5, "b"), row(7, 1, "c")], 6).map((p) => p.pid),
    ).toEqual([7]);
  });
});

describe("refusal", () => {
  test("names the action, the path, the count and the first processes", () => {
    const message = refusal(
      "package",
      BUNDLE,
      [1, 2, 3, 4].map((n) => row(n, 0, `cmd ${n}`)),
    );
    expect(message).toContain("refusing to package");
    expect(message).toContain(`4 running processes live in ${BUNDLE}`);
    expect(message).toContain("pid 3  cmd 3");
    expect(message).not.toContain("pid 4");
  });
});
