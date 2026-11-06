import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, parse, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let claudeConfig: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  claudeConfig = mkdtempSync(join(tmpdir(), "handoff-cards-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(claudeConfig, { recursive: true, force: true });
});

/** Writes a bot's Claude Code session file as the real CLI would have, so a reopened bot is rebuilt from it. */
function writeSession(botId: string, msgs: { type: "user" | "assistant"; content: unknown }[]) {
  const dir = join(claudeConfig, "projects", host.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = msgs.map((m, i) => ({
    uuid: `${botId}-${i}`,
    parentUuid: i ? `${botId}-${i - 1}` : null,
    sessionId: botId,
    timestamp: new Date().toISOString(),
    cwd: host.cwd,
    isSidechain: false,
    type: m.type,
    message: { role: m.type, content: m.content },
  }));
  writeFileSync(join(dir, `${botId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

type Card = {
  type: "handoff";
  direction: string;
  bot: string;
  botId?: string;
  title: string;
  status: string;
  text: string;
};

/** What a page connecting now would be sent for the open bot's transcript. */
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
const cards = async () =>
  (await pageEvents()).filter((e): e is Card & typeof e => e.type === "handoff");
const open = (id: string) => host.ui("/api/open", { id, botId: id });

describe("handoff cards", () => {
  test("the open assignee shows a received card for the brief and its sender, and no raw tag as a user message", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    await open(b);
    const alice = await host.actAs(a);
    await alice.call("hand_off", { to: b, title: "Flights", brief: "find <one> & cheap" });
    await host.until(() => host.messagesOf(b).length === 1);
    const events = await pageEvents();
    expect(events.filter((e) => e.type === "handoff")).toEqual([
      {
        type: "handoff",
        direction: "received",
        bot: "Alice",
        botId: a,
        title: "Flights",
        status: "submitted",
        text: "find <one> & cheap",
      },
    ]);
    expect(events.some((e) => e.type === "user")).toBe(false);
  });

  test("the requester's transcript shows its outgoing card and the result update", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    await open(a);
    const alice = await host.actAs(a);
    const bob = await host.actAs(b);
    const { handoff_id } = parse<{ handoff_id: string }>(
      await alice.call("hand_off", { to: b, title: "Flights", brief: "find one" }),
    );
    await host.until(() => host.messagesOf(b).length === 1);
    await bob.call("complete_handoff", { handoff_id, result: "EUR 99" });
    await host.until(() => host.messagesOf(a).length === 1);
    expect(
      (await cards()).map(({ direction, bot, botId, title, status, text }) => ({
        direction,
        bot,
        botId,
        title,
        status,
        text,
      })),
    ).toEqual([
      {
        direction: "sent",
        bot: "Bob",
        botId: b,
        title: "Flights",
        status: "submitted",
        text: "find one",
      },
      {
        direction: "received",
        bot: "Bob",
        botId: b,
        title: "Flights",
        status: "completed",
        text: "EUR 99",
      },
    ]);
  });

  test("the assignee shows as working while it runs the handoff turn", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    host.hold();
    await (await host.actAs(a)).call("hand_off", { to: b, title: "t", brief: "x" });
    await host.until(() => host.messagesOf(b).length === 1);
    const bots = (await pageEvents()).find((e) => e.type === "bots") as unknown as {
      bots: { id: string; status: string }[];
    };
    expect(bots.bots.find((x) => x.id === b)?.status).toBe("working");
  });

  test("handoff_message shows a sent card to its caller live", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    await open(b);
    const alice = await host.actAs(a);
    const bob = await host.actAs(b);
    const { handoff_id } = parse<{ handoff_id: string }>(
      await alice.call("hand_off", { to: b, title: "Flights", brief: "find one" }),
    );
    await host.until(() => host.messagesOf(b).length === 1);
    await bob.call("handoff_message", { handoff_id, text: "which month?" });
    expect((await cards()).at(-1)).toMatchObject({
      direction: "sent",
      bot: "Alice",
      title: "Flights",
      status: "input-required",
      text: "which month?",
    });
  });

  test("a reopened assignee whose session starts with the brief rebuilds its cards, including handoff_message and fail_handoff", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    const { handoff_id } = parse<{ handoff_id: string }>(
      await (await host.actAs(a)).call("hand_off", { to: b, title: "Flights", brief: "find one" }),
    );
    await host.until(() => host.messagesOf(b).length === 1);
    await open(a); // closes Bob's idle chat so reopening it reads its session file
    writeSession(b, [
      {
        type: "user",
        content: `<handoff id="${handoff_id}" requester="Alice" title="Flights">\nfind one\n</handoff>\nContinue or finish this handoff.`,
      },
      {
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__bots__handoff_message",
            input: { handoff_id, text: "which month?" },
          },
        ],
      },
      {
        type: "user",
        content: `<handoff-update id="${handoff_id}" from="Alice" status="working">\nMay\n</handoff-update>`,
      },
      {
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "mcp__bots__fail_handoff",
            input: { handoff_id, reason: "no flights" },
          },
        ],
      },
    ]);
    const logs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await open(b);
      await host.ui("/api/send", { text: "continue" });
      await host.until(() =>
        logs.some((l) => l.includes("query opened") && l.includes(`session=${b}`)),
      );
    } finally {
      console.error = realError;
    }
    expect(logs.find((l) => l.includes("query opened") && l.includes(`session=${b}`))).toContain(
      "(resume)",
    );
    const events = await pageEvents();
    expect(
      events
        .filter((e) => e.type === "handoff")
        .map(({ direction, bot, botId, title, status, text }) => ({
          direction,
          bot,
          botId,
          title,
          status,
          text,
        })),
    ).toEqual([
      {
        direction: "received",
        bot: "Alice",
        botId: a,
        title: "Flights",
        status: "submitted",
        text: "find one",
      },
      {
        direction: "sent",
        bot: "Alice",
        botId: a,
        title: "Flights",
        status: "input-required",
        text: "which month?",
      },
      {
        direction: "received",
        bot: "Alice",
        botId: a,
        title: "Flights",
        status: "working",
        text: "May",
      },
      {
        direction: "sent",
        bot: "Alice",
        botId: a,
        title: "Flights",
        status: "failed",
        text: "no flights",
      },
    ]);
    expect(events.filter((e) => e.type === "user").map((e) => e.text)).toEqual(["continue"]);
  });

  test("a resumed brief shows the handoff's current status, not submitted", async () => {
    const a = host.createBot("Alice", "plans");
    const b = host.createBot("Bob", "flights");
    const { handoff_id } = parse<{ handoff_id: string }>(
      await (await host.actAs(a)).call("hand_off", { to: b, title: "Flights", brief: "find one" }),
    );
    await host.until(() => host.messagesOf(b).length === 1); // the brief starts Bob's turn: status working
    await open(a);
    writeSession(b, [
      {
        type: "user",
        content: `<handoff id="${handoff_id}" requester="Alice" title="Flights" resumed="true">\nfind one\n</handoff>`,
      },
    ]);
    await open(b);
    expect((await cards())[0]).toMatchObject({ direction: "received", status: "working" });
  });
});
