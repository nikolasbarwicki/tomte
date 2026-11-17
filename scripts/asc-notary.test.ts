// The asc notary backend against a recording fake runner: no `asc`, keychain or Apple service is started.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AscNotary,
  ascLogArgv,
  ascSubmitArgv,
  notarizeSignedApp,
  notarizeWithAsc,
  parseAscSubmission,
  readSubmissionRecord,
} from "./asc-notary.ts";
import { CommandError, type Ran, type Runner } from "./command-runner.ts";

const ASC: AscNotary = { bin: "/opt/homebrew/bin/asc", profile: "ASC API" };
const URL = "https://synthetic.invalid/developer-log/sub-1";

let root: string;
let file: string;
const digest = new Bun.CryptoHasher("sha256").update("SYNTHETIC UPLOAD").digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tomte-asc-notary-test-"));
  file = join(root, "Tomte-0.1.0-arm64.dmg");
  await writeFile(file, "SYNTHETIC UPLOAD");
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** Plays asc: `submit` answers with `answer` (or throws it as a failed command), `log` with the URL. */
function fakeAsc(
  answer: { stdout: string; exit?: number },
  options: { logFails?: boolean } = {},
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd): Promise<Ran> => {
    calls.push([...cmd]);
    if (cmd.includes("log")) {
      if (options.logFails) throw new CommandError(cmd[0]!, 1, "", "no such submission");
      return { stdout: `${URL}\n`, stderr: "" };
    }
    if (cmd.includes("submit")) {
      if (answer.exit) throw new CommandError(cmd[0]!, answer.exit, answer.stdout, "asc: failed");
      return { stdout: answer.stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

const notarize = (run: Runner, logs: string[] = []) =>
  notarizeWithAsc({ run, asc: ASC, file, kind: "dmg", log: (l) => logs.push(l) });

describe("argv", () => {
  test("submit names the profile, the file and --wait with json output, and never --read-only", () => {
    expect(ascSubmitArgv(ASC, "/x/a.dmg")).toEqual([
      "/opt/homebrew/bin/asc",
      "--profile",
      "ASC API",
      "notarization",
      "submit",
      "--file",
      "/x/a.dmg",
      "--wait",
      "--output",
      "json",
    ]);
    expect(ascSubmitArgv(ASC, "/x/a.dmg")).not.toContain("--read-only");
  });

  test("log names the profile and the submission id", () => {
    expect(ascLogArgv(ASC, "sub-1")).toEqual([
      "/opt/homebrew/bin/asc",
      "--profile",
      "ASC API",
      "notarization",
      "log",
      "--id",
      "sub-1",
    ]);
  });
});

describe("parseAscSubmission", () => {
  test.each([
    ["a flat object", '{"id":"s1","status":"Accepted"}'],
    ["JSON:API", '{"data":{"id":"s1","type":"submissions","attributes":{"status":"Accepted"}}}'],
    ["data holding id and status", '{"data":{"id":"s1","status":"Accepted"}}'],
    ["data as a list", '{"data":[{"id":"s1","attributes":{"status":"Accepted"}}]}'],
    ["a submission object", '{"submission":{"id":"s1","status":"Accepted"}}'],
    ["a list at the top", '[{"id":"s1","status":"Accepted"}]'],
    ["pretty-printed", '{\n  "id": "s1",\n  "status": "Accepted"\n}\n'],
    [
      "progress lines before the document",
      'Waiting...\nPolling...\n{"id":"s1","status":"Accepted"}',
    ],
  ])("reads id and status from %s", (_name, stdout) => {
    expect(parseAscSubmission(stdout)).toEqual({ id: "s1", status: "Accepted" });
  });

  test("the first string of each wins and non-strings are skipped", () => {
    expect(
      parseAscSubmission('{"id":7,"status":{"x":1},"data":{"id":"s2","status":"Invalid"}}'),
    ).toEqual({
      id: "s2",
      status: "Invalid",
    });
  });

  test.each([
    ["malformed text", "Error: something"],
    ["empty output", ""],
    ["a scalar", "42"],
    ["an empty object", "{}"],
    ["an empty list", "[]"],
  ])("yields nothing for %s", (_name, stdout) => {
    expect(parseAscSubmission(stdout)).toEqual({ id: undefined, status: undefined });
  });
});

describe("notarizeWithAsc", () => {
  test("an Accepted submission returns its record with the sha256 of the uploaded file", async () => {
    const asc = fakeAsc({ stdout: '{"id":"sub-1","status":"Accepted"}' });
    const logs: string[] = [];
    expect(await notarize(asc.run, logs)).toEqual({
      kind: "dmg",
      file: "Tomte-0.1.0-arm64.dmg",
      sha256: digest,
      id: "sub-1",
      status: "Accepted",
    });
    expect(asc.calls).toEqual([ascSubmitArgv(ASC, file)]);
    expect(logs.join("\n")).toContain("submission sub-1");
  });

  test("the status is compared case-insensitively but must be the whole word", async () => {
    const ok = fakeAsc({ stdout: '{"id":"sub-1","status":"accepted"}' });
    expect((await notarize(ok.run)).status).toBe("accepted");
    const no = fakeAsc({ stdout: '{"id":"sub-1","status":"Not Accepted"}' });
    await expect(notarize(no.run)).rejects.toThrow("status Not Accepted");
  });

  test("Accepted without a readable id succeeds, records no id and says so", async () => {
    const logs: string[] = [];
    const record = await notarize(fakeAsc({ stdout: '{"status":"Accepted"}' }).run, logs);
    expect(record.id).toBeUndefined();
    expect(logs.join("\n")).toContain("no readable submission id");
  });

  test.each([
    ["a rejection with exit 0", { stdout: '{"id":"sub-1","status":"Invalid"}' }],
    ["a rejection with a non-zero exit", { stdout: '{"id":"sub-1","status":"Invalid"}', exit: 1 }],
    ["a timeout while in progress", { stdout: '{"id":"sub-1","status":"In Progress"}' }],
    [
      "a non-zero exit with an Accepted body",
      { stdout: '{"id":"sub-1","status":"Accepted"}', exit: 2 },
    ],
  ])("fails for %s with the id, the digest and the log URL", async (_name, answer) => {
    const asc = fakeAsc(answer);
    const error = await notarize(asc.run).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain("notarizing Tomte-0.1.0-arm64.dmg with asc failed");
    expect(message).toContain("submission sub-1");
    expect(message).toContain(`sha256 ${digest}`);
    expect(message).toContain(URL);
    expect(asc.calls.at(-1)).toEqual(ascLogArgv(ASC, "sub-1"));
  });

  test("a failing log fetch is reported and the rejection stays the error", async () => {
    const asc = fakeAsc({ stdout: '{"id":"sub-1","status":"Invalid"}' }, { logFails: true });
    const message = ((await notarize(asc.run).catch((e: Error) => e)) as Error).message;
    expect(message).toContain("status Invalid");
    expect(message).toContain("the log of submission sub-1 could not be fetched");
    expect(message).toContain("no such submission");
  });

  test("unreadable output fails, fetches no log (there is no id) and shows what asc printed", async () => {
    const asc = fakeAsc({ stdout: "something unexpected", exit: 1 });
    const message = ((await notarize(asc.run).catch((e: Error) => e)) as Error).message;
    expect(message).toContain("status (unreadable), submission (none)");
    expect(message).toContain("asc printed: something unexpected");
    expect(asc.calls).toHaveLength(1);
  });

  test("unreadable output with exit 0 is a failure too", async () => {
    const asc = fakeAsc({ stdout: "" });
    const message = ((await notarize(asc.run).catch((e: Error) => e)) as Error).message;
    expect(message).toContain("asc printed: (empty)");
  });

  test("an error that is not a failed command is not swallowed", async () => {
    const run: Runner = async () => {
      throw new TypeError("spawn failed");
    };
    await expect(notarize(run)).rejects.toThrow("spawn failed");
  });
});

describe("notarizeSignedApp (electron-builder's afterSign)", () => {
  const app = () => join(root, "mac-arm64", "Tomte.app");

  /** Records every command; `ditto` creates the zip it is asked for, as the real one does. */
  function hookRun(status = "Accepted") {
    const calls: string[][] = [];
    const run: Runner = async (cmd) => {
      calls.push([...cmd]);
      if (cmd[0] === "ditto") await writeFile(cmd.at(-1)!, "SYNTHETIC APP ZIP");
      if (cmd.includes("submit")) {
        const body = JSON.stringify({ id: "app-sub", status });
        if (status !== "Accepted") throw new CommandError(cmd[0]!, 1, body, "rejected");
        return { stdout: body, stderr: "" };
      }
      return { stdout: cmd.includes("log") ? URL : "", stderr: "" };
    };
    return { run, calls };
  }

  beforeEach(() => mkdir(app(), { recursive: true }));

  test("zips the app, notarizes the zip, then staples and validates the app, in that order", async () => {
    const { run, calls } = hookRun();
    const recordFile = join(root, "record.json");
    await notarizeSignedApp({ run, asc: ASC, app: app(), recordFile, log: () => {} });

    const zip = calls[0]!.at(-1)!;
    expect(calls).toEqual([
      ["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app(), zip],
      ascSubmitArgv(ASC, zip),
      ["xcrun", "stapler", "staple", app()],
      ["xcrun", "stapler", "validate", app()],
    ]);
    expect(zip.endsWith("/Tomte.zip")).toBe(true);
    expect(await readSubmissionRecord(recordFile)).toEqual({
      kind: "app",
      file: "Tomte.zip",
      sha256: new Bun.CryptoHasher("sha256").update("SYNTHETIC APP ZIP").digest("hex"),
      id: "app-sub",
      status: "Accepted",
    });
  });

  test("removes the zip it made, whether the submission succeeds or not", async () => {
    for (const status of ["Accepted", "Invalid"]) {
      const { run, calls } = hookRun(status);
      await notarizeSignedApp({
        run,
        asc: ASC,
        app: app(),
        recordFile: join(root, "record.json"),
        log: () => {},
      }).catch(() => undefined);
      const zip = calls[0]!.at(-1)!;
      expect(await Bun.file(zip).exists()).toBe(false);
    }
  });

  test("a rejection stops before stapling and leaves no record", async () => {
    const { run, calls } = hookRun("Invalid");
    const recordFile = join(root, "record.json");
    await expect(
      notarizeSignedApp({ run, asc: ASC, app: app(), recordFile, log: () => {} }),
    ).rejects.toThrow(/notarizing Tomte.zip with asc failed.*app-sub/s);
    expect(calls.some((c) => c.includes("stapler"))).toBe(false);
    expect(calls.at(-1)).toEqual(ascLogArgv(ASC, "app-sub"));
    expect(await Bun.file(recordFile).exists()).toBe(false);
  });
});

describe("readSubmissionRecord", () => {
  const read = async (text: string) => {
    const path = join(root, "r.json");
    await writeFile(path, text);
    return readSubmissionRecord(path);
  };
  const good = {
    kind: "app" as const,
    file: "Tomte.zip",
    sha256: "ab",
    id: "s",
    status: "Accepted",
  };

  test("reads a record, with a null id as no id", async () => {
    expect(await read(JSON.stringify(good))).toEqual(good);
    expect((await read(JSON.stringify({ ...good, id: null }))).id).toBeUndefined();
  });

  test.each([
    ["not an object", "[]"],
    ["an unknown kind", JSON.stringify({ ...good, kind: "pkg" })],
    ["a missing file", JSON.stringify({ ...good, file: undefined })],
    ["a numeric id", JSON.stringify({ ...good, id: 5 })],
    ["a missing status", JSON.stringify({ ...good, status: undefined })],
  ])("refuses %s", async (_name, text) => {
    await expect(read(text)).rejects.toThrow("is not a notarization record");
  });
});
