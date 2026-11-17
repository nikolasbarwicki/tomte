import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botFilesPath } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let botId: string;
let files: string;
let claudeConfig: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  claudeConfig = mkdtempSync(join(tmpdir(), "attachments-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  host = await startHandoffHost();
  botId = host.createBot("Ada");
  files = botFilesPath(host.dataRoot, botId);
});

afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(claudeConfig, { recursive: true, force: true });
});

const open = () => host.ui("/api/open", { botId });
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const attach = async (...entries: [path: string, data: string | Uint8Array][]) => {
  const res = await host.ui("/api/files/attach", {
    files: entries.map(([path, data]) => ({ path, data: b64(data) })),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

async function userEvents(): Promise<unknown[]> {
  const ctl = new AbortController();
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: ctl.signal,
    headers: host.authHeaders,
  });
  const reader = res.body!.getReader();
  let text = "";
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(100).then(() => undefined)]);
    if (r?.value) text += new TextDecoder().decode(r.value);
  }
  ctl.abort();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { type: string })
    .filter((e) => e.type === "user");
}

describe("attaching", () => {
  beforeEach(async () => {
    expect((await open()).status).toBe(200);
  });

  test("a file is saved with its exact bytes, and a second one of the same name gets a new name", async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(await attach(["report.v1.bin", bytes])).toEqual({
      status: 200,
      body: { attachment: { path: "attachments/report.v1.bin", folder: false } },
    });
    expect(await attach(["report.v1.bin", "other"])).toEqual({
      status: 200,
      body: { attachment: { path: "attachments/report.v1 2.bin", folder: false } },
    });
    expect(new Uint8Array(readFileSync(join(files, "attachments", "report.v1.bin")))).toEqual(
      bytes,
    );
    expect(readFileSync(join(files, "attachments", "report.v1 2.bin"), "utf8")).toBe("other");
  });

  test("a folder keeps its tree under one name", async () => {
    expect(await attach(["notes/a.md", "A"], ["notes/2026/june.md", "J"])).toEqual({
      status: 200,
      body: { attachment: { path: "attachments/notes", folder: true } },
    });
    expect((await attach(["notes/b.md", "B"])).body).toEqual({
      attachment: { path: "attachments/notes 2", folder: true },
    });
    expect(readFileSync(join(files, "attachments", "notes", "2026", "june.md"), "utf8")).toBe("J");
    expect(readdirSync(join(files, "attachments", "notes 2"))).toEqual(["b.md"]);
  });

  test("paths that escape, mix names or mix a file with a folder are refused and write nothing", async () => {
    for (const entries of [
      [["../evil.txt", "x"]],
      [["notes/../../evil.txt", "x"]],
      [["/etc/evil.txt", "x"]],
      [
        ["a/x.txt", "x"],
        ["b/y.txt", "y"],
      ],
      [
        ["a", "x"],
        ["a/y.txt", "y"],
      ],
      [
        ["a.txt", "x"],
        ["a.txt", "y"],
      ],
    ] as [string, string][][]) {
      expect((await attach(...entries)).status).toBe(400);
    }
    expect(existsSync(join(files, "evil.txt"))).toBe(false);
    expect(existsSync(join(files, "..", "evil.txt"))).toBe(false);
    expect(existsSync(join(files, "attachments"))).toBe(false);
  });

  test("an attachments folder a bot swapped for a symlink outside is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "attachments-outside-"));
    try {
      mkdirSync(files, { recursive: true });
      symlinkSync(outside, join(files, "attachments"));
      expect((await attach(["report.txt", "x"])).status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sending with attachments", () => {
  beforeEach(async () => {
    expect((await open()).status).toBe(200);
  });

  test("the bot gets each attachment's absolute path, and the page shows them beside the text", async () => {
    const file = (await attach(["report.txt", "r"])).body.attachment;
    const folder = (await attach(["notes/a.md", "a"])).body.attachment;
    expect(
      (await host.ui("/api/send", { text: "read these", attachments: [file, folder] })).status,
    ).toBe(200);
    await host.until(() => host.messagesOf(botId).length === 1);
    expect(host.messagesOf(botId)[0]).toBe(
      [
        "read these",
        `<attachment kind="file" path="${join(files, "attachments", "report.txt")}"/>`,
        `<attachment kind="folder" path="${join(files, "attachments", "notes")}"/>`,
      ].join("\n"),
    );
    expect(await userEvents()).toEqual([
      { type: "user", text: "read these", attachments: [file, folder], at: expect.any(Number) },
    ]);
  });

  test("a message may be only attachments", async () => {
    const file = (await attach(["report.txt", "r"])).body.attachment;
    expect((await host.ui("/api/send", { text: "", attachments: [file] })).status).toBe(200);
    await host.until(() => host.messagesOf(botId).length === 1);
    expect(host.messagesOf(botId)[0]).toBe(
      `<attachment kind="file" path="${join(files, "attachments", "report.txt")}"/>`,
    );
  });

  test("an attachment that is not in the files folder is refused and nothing is delivered", async () => {
    for (const a of [
      { path: "attachments/missing.txt", folder: false },
      { path: "../../outside", folder: true },
    ]) {
      expect((await host.ui("/api/send", { text: "hi", attachments: [a] })).status).toBe(400);
    }
    expect(host.messagesOf(botId)).toEqual([]);
  });
});

test("reopening replays attachments beside the text, not as raw tags", async () => {
  const dir = join(claudeConfig, "projects", host.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const report = join(files, "attachments", "report.txt");
  const sent = Date.UTC(2026, 10, 17, 9, 30);
  const msgs = [
    `look\n<attachment kind="file" path="${report}"/>`,
    `<attachment kind="folder" path="${join(files, "attachments", "notes")}"/>`,
  ];
  const lines = msgs.map((t, i) => ({
    uuid: `m${i}`,
    parentUuid: i ? `m${i - 1}` : null,
    sessionId: botId,
    timestamp: new Date(sent).toISOString(),
    cwd: host.cwd,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: t },
  }));
  writeFileSync(join(dir, `${botId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await open();
  expect(await userEvents()).toEqual([
    {
      type: "user",
      text: "look",
      attachments: [{ path: "attachments/report.txt", folder: false }],
      at: sent,
    },
    {
      type: "user",
      text: "",
      attachments: [{ path: "attachments/notes", folder: true }],
      at: sent,
    },
  ]);
});
