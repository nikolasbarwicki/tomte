import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let claudeConfig: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  claudeConfig = mkdtempSync(join(tmpdir(), "mentions-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  savedConfig === undefined
    ? delete process.env.CLAUDE_CONFIG_DIR
    : (process.env.CLAUDE_CONFIG_DIR = savedConfig);
  rmSync(claudeConfig, { recursive: true, force: true });
});

async function pageEvents(): Promise<{ type: string; [k: string]: unknown }[]> {
  const ctl = new AbortController();
  const res = await fetch(`${host.server.url}/api/events`, { signal: ctl.signal });
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
    .map((l) => JSON.parse(l.slice(6)));
}
const open = (id: string) => host.ui("/api/open", { id, botId: id });

describe("mentions", () => {
  test("a mention delivers the text plus one tag per mentioned bot, shown as chips", async () => {
    const a = host.createBot("Researcher");
    const w = host.createBot("Writer");
    const e = host.createBot("Editor");
    await open(a);
    expect((await host.ui("/api/send", { text: "draft this", mentions: [w, e] })).status).toBe(200);
    await host.until(() => host.messagesOf(a).length === 1);
    expect(host.messagesOf(a)[0]).toBe(
      `draft this\n<mention name="Writer" id="${w}"/>\n<mention name="Editor" id="${e}"/>`,
    );
    const user = (await pageEvents()).filter((x) => x.type === "user");
    expect(user).toEqual([
      {
        type: "user",
        text: "draft this",
        mentions: [
          { id: w, name: "Writer" },
          { id: e, name: "Editor" },
        ],
      },
    ]);
  });

  test("an unknown bot or the open bot is refused and nothing is delivered", async () => {
    const a = host.createBot("Researcher");
    const w = host.createBot("Writer");
    await open(a);
    expect((await host.ui("/api/send", { text: "hi", mentions: ["nope"] })).status).toBe(400);
    expect((await host.ui("/api/send", { text: "hi", mentions: [w, a] })).status).toBe(400);
    await Bun.sleep(300);
    expect(host.messagesOf(a)).toEqual([]);
    expect((await pageEvents()).some((x) => x.type === "user")).toBe(false);
  });

  test("reopening replays the mention as a chip, not a raw tag; plain @Name stays text", async () => {
    const a = host.createBot("Researcher");
    const w = host.createBot("Writer");
    const dir = join(claudeConfig, "projects", host.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const msgs = [`draft this\n<mention name="Writer" id="${w}"/>`, "ping @Writer"];
    const lines = msgs.map((t, i) => ({
      uuid: `m${i}`,
      parentUuid: i ? `m${i - 1}` : null,
      sessionId: a,
      timestamp: new Date().toISOString(),
      cwd: host.cwd,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: t },
    }));
    writeFileSync(join(dir, `${a}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await open(a);
    expect((await pageEvents()).filter((x) => x.type === "user")).toEqual([
      { type: "user", text: "draft this", mentions: [{ id: w, name: "Writer" }] },
      { type: "user", text: "ping @Writer" },
    ]);
  });

  test("the system prompt carries the mention rule", async () => {
    const a = host.createBot("Researcher");
    host.createBot("Writer");
    await open(a);
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => host.launches().length > 0);
    expect(host.launches()[0].appendSystemPrompt).toContain("<mention");
  });
});
