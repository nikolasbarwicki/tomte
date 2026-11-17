import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
let claudeConfig: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  claudeConfig = mkdtempSync(join(tmpdir(), "ask-user-cfg-"));
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
    .flatMap((l) => eventsOf(l.slice(6)));
}
const asks = async () => (await pageEvents()).filter((e) => e.type === "ask");
/** The one question shown to a page that connects once the fake CLI has asked it. */
async function theAsk() {
  await host.until(() => host.messagesOf(botId).length === 1);
  const found = await asks();
  expect(found).toHaveLength(1);
  return found[0]!;
}
let botId: string;

/** Opens a bot and sends a message, which makes the fake CLI call `ask_user` with `question` and `options`. */
async function askedBot(question: string, options?: string[]) {
  const id = host.createBot("Dev");
  botId = id;
  await host.ui("/api/open", { id, botId: id });
  host.askOnMessage(question, options);
  expect((await host.ui("/api/send", { text: "go" })).status).toBe(200);
  return id;
}

describe("ask_user options", () => {
  test("the options reach the ask event, and a chip answers the tool with its label", async () => {
    await askedBot("Land it?", ["Land", "Land after check", "Hold"]);
    const ask = await theAsk();
    expect(ask).toMatchObject({
      question: "Land it?",
      options: ["Land", "Land after check", "Hold"],
    });

    expect((await host.ui("/api/answer", { id: ask.id, value: "Land after check" })).status).toBe(
      200,
    );
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Land after check"]);
    expect((await host.ui("/api/answer", { id: ask.id, value: "Land" })).status).toBe(404);
  });

  test("a free-text answer still works on a question with options", async () => {
    await askedBot("Which branch?", ["main", "dev"]);
    const ask = await theAsk();
    await host.ui("/api/answer", { id: ask.id, value: "release/2" });
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["release/2"]);
  });

  test("a question without options carries none", async () => {
    await askedBot("Name?");
    const ask = await theAsk();
    expect(ask).toMatchObject({ question: "Name?" });
    expect("options" in ask).toBe(false);
  });

  test("more than six options are refused and no question is shown", async () => {
    await askedBot("Pick", ["1", "2", "3", "4", "5", "6", "7"]);
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()[0]).toContain("options");
    expect(await asks()).toEqual([]);
  });
});
