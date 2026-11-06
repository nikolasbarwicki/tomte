import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let claudeConfig: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  claudeConfig = mkdtempSync(join(tmpdir(), "queue-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(claudeConfig, { recursive: true, force: true });
});

type PageEvent = { type: string; [k: string]: unknown };
/** What a page that connects now is replayed. */
async function pageEvents(): Promise<PageEvent[]> {
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
    .map((l) => JSON.parse(l.slice(6)));
}
const chatEvents = async () =>
  (await pageEvents()).filter((e) => ["user", "queued", "dequeued"].includes(e.type));
const open = (id: string) => host.ui("/api/open", { id, botId: id });
/** Sends a message from the page; the reply names the queued entry when the bot was busy. */
const send = async (text: string) =>
  (await (await host.ui("/api/send", { text })).json()) as { ok: true; queued?: string };

/** Opens a bot and leaves its first turn running. */
async function busyBot() {
  const a = host.createBot("Researcher");
  await open(a);
  host.hold();
  expect((await host.ui("/api/send", { text: "first" })).status).toBe(200);
  await host.until(() => host.messagesOf(a).length === 1);
  return a;
}

describe("message queue", () => {
  test("messages sent during a turn wait, then reach the bot together as the next turn", async () => {
    const a = await busyBot();
    const second = await send("second");
    await host.ui("/api/send", { text: "third" });
    expect(second.queued).toBeString();

    const waiting = await chatEvents();
    expect(waiting.map((e) => [e.type, e.text])).toEqual([
      ["user", "first"],
      ["queued", "second"],
      ["queued", "third"],
    ]);
    expect(host.messagesOf(a)).toEqual(["first"]);

    host.release();
    await host.until(() => host.messagesOf(a).length === 2);
    expect(host.messagesOf(a)[1]).toBe("second\n\nthird");

    const ran = await chatEvents();
    expect(ran.filter((e) => e.type === "queued")).toHaveLength(2);
    expect(ran.filter((e) => e.type === "dequeued").map((e) => e.id)).toHaveLength(2);
    expect(ran.filter((e) => e.type === "user").map((e) => e.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("a cancelled message never reaches the bot, and cancelling it twice is refused", async () => {
    const a = await busyBot();
    const { queued } = await send("oops");
    await host.ui("/api/send", { text: "keep" });

    expect((await host.ui("/api/send/cancel", { id: queued })).status).toBe(200);
    expect((await host.ui("/api/send/cancel", { id: queued })).status).toBe(404);

    host.release();
    await host.until(() => host.messagesOf(a).length === 2);
    expect(host.messagesOf(a)[1]).toBe("keep");
    const events = await chatEvents();
    expect(host.messagesOf(a)).toEqual(["first", "keep"]);
    expect(events.some((e) => e.text === "oops" && e.type === "user")).toBe(false);
  });

  test("a send to an idle bot runs at once and is not queued", async () => {
    const a = host.createBot("Researcher");
    await open(a);
    const sent = await send("hi");
    expect(sent.queued).toBeUndefined();
    expect((await host.ui("/api/send/cancel", { id: "nope" })).status).toBe(404);
  });

  test("a queued mention keeps its tag in what the bot receives and its chip on the page", async () => {
    const a = await busyBot();
    const w = host.createBot("Writer");
    await host.ui("/api/send", { text: "draft this", mentions: [w] });
    expect((await chatEvents()).find((e) => e.type === "queued")).toMatchObject({
      text: "draft this",
      mentions: [{ id: w, name: "Writer" }],
    });

    host.release();
    await host.until(() => host.messagesOf(a).length === 2);
    expect(host.messagesOf(a)[1]).toBe(`draft this\n<mention name="Writer" id="${w}"/>`);
  });
});
