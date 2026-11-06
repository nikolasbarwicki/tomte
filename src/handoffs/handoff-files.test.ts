import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botFilesPath } from "../bots/index.ts";
import { startHandoffHost, parse, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

const BRIEF = "Goal: a report. Context: none. Constraints: none. Deliverable: a file. Done when: written.";

async function started() {
  const a = host.createBot("Alice");
  const b = host.createBot("Bob");
  const alice = await host.actAs(a);
  const bob = await host.actAs(b);
  const { handoff_id } = parse<{ handoff_id: string }>(await alice.call("hand_off", { to: b, title: "t", brief: BRIEF }));
  const bobDir = botFilesPath(host.cwd, b);
  const aliceDir = botFilesPath(host.cwd, a);
  const put = (dir: string, name: string, text: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  return { a, alice, bob, id: handoff_id, bobDir, aliceDir, put };
}

/** The requester's files list as the UI receives it on /api/events. */
async function filesListOf(botId: string): Promise<string[]> {
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  const abort = new AbortController();
  const res = await fetch(`${host.server.url}/api/events`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const m of buf.matchAll(/data: (.*)\n\n/g)) {
        const e = JSON.parse(m[1]!);
        if (e.type === "files") return e.files.map((f: { path: string }) => f.path);
      }
    }
    return [];
  } finally {
    abort.abort();
  }
}

describe("files as handoff results", () => {
  test("completing with files copies them into the requester's handoffs/<id>/ folder, lists them, and shows in the UI files list", async () => {
    const { a, alice, bob, id, bobDir, aliceDir, put } = await started();
    put(bobDir, "report.md", "# findings\n");
    put(bobDir, "data/rows.csv", "a,b\n1,2\n");
    const r = await bob.call("complete_handoff", { handoff_id: id, result: "done", files: ["report.md", "data/rows.csv"] });
    expect(r.isError).toBe(false);
    const paths = [`handoffs/${id}/report.md`, `handoffs/${id}/data/rows.csv`];
    expect(parse<{ files: string[] }>(r).files).toEqual(paths);
    expect(readFileSync(join(aliceDir, paths[0]!), "utf8")).toBe("# findings\n");
    expect(readFileSync(join(aliceDir, paths[1]!), "utf8")).toBe("a,b\n1,2\n");
    await host.until(() => host.messagesOf(a).some((m) => m.includes(paths[0]!) && m.includes(paths[1]!)));
    expect((await filesListOf(a)).sort()).toEqual([...paths].sort());
    expect(alice).toBeDefined();
  });

  test("a name escaping the files folder is refused, nothing is copied, and the handoff stays open", async () => {
    const { bob, id, bobDir, aliceDir, put } = await started();
    put(bobDir, "ok.md", "fine");
    const outside = join(host.cwd, "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(bobDir, "link.txt"));
    for (const bad of ["../secret.txt", outside, "link.txt"]) {
      const r = await bob.call("complete_handoff", { handoff_id: id, result: "done", files: ["ok.md", bad] });
      expect(r.isError).toBe(true);
      expect(existsSync(join(aliceDir, "handoffs", id))).toBe(false);
    }
    expect((await bob.call("complete_handoff", { handoff_id: id, result: "done", files: ["ok.md"] })).isError).toBe(false);
  });

  test("a missing file is refused and the handoff stays open", async () => {
    const { bob, id, aliceDir } = await started();
    const r = await bob.call("complete_handoff", { handoff_id: id, result: "done", files: ["nope.md"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("nope.md");
    expect(existsSync(join(aliceDir, "handoffs", id))).toBe(false);
    expect((await bob.call("complete_handoff", { handoff_id: id, result: "done" })).isError).toBe(false);
  });
});
