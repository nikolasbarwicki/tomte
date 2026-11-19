import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UploadResponse } from "@tomte/contract/api";
import type { Attachment } from "@tomte/contract/events";

import { botFilesPath } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { uploadFile } from "../testing/upload-file.ts";
import { eventsOf } from "../testing/watch-events.ts";

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

/** What the page does before it sends a file: uploads it under `attachments/`. */
async function saveFile(name: string, data: string): Promise<Attachment> {
  const res = await uploadFile(host, `attachments/${name}`, data);
  expect(res.status).toBe(200);
  return { path: ((await res.json()) as UploadResponse).path, folder: false };
}

/** What the page does before it sends a folder: uploads each file into one new folder under `attachments/`. */
async function saveFolder(
  name: string,
  ...files: [path: string, data: string][]
): Promise<Attachment> {
  let top = `attachments/${name}`;
  for (const [path, data] of files) {
    const res = await uploadFile(host, `${top}/${path}`, data, { folder: top });
    expect(res.status).toBe(200);
    top = ((await res.json()) as UploadResponse).path.split("/").slice(0, 2).join("/");
  }
  return { path: top, folder: true };
}

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
    .flatMap((l) => eventsOf(l.slice(6)) as { type: string }[])
    .filter((e) => e.type === "user");
}

describe("sending with attachments", () => {
  beforeEach(async () => {
    expect((await open()).status).toBe(200);
  });

  test("the bot gets each attachment's absolute path, and the page shows them beside the text", async () => {
    const file = await saveFile("report.txt", "r");
    const folder = await saveFolder("notes", ["a.md", "a"]);
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
    const file = await saveFile("report.txt", "r");
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
