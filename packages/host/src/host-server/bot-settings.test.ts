import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Instructions, ModelProviders } from "@claudebot/contract/api";

import {
  botMemoryPath,
  getBot,
  instructionsPath,
  readMemory,
  setChatMode,
  touchBot,
  userMemoryPath,
} from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bot-settings-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

const AVATAR = { face: "crown", stroke: "teal" } as const;
const profile = (botId: string, body: object = {}) =>
  host.ui("/api/bots/profile", {
    botId,
    name: "Grace",
    purpose: "Reviews code",
    ...AVATAR,
    ...body,
  });
const promptOf = (n: number) => defined(host.launches()[n], `launch ${n}`).appendSystemPrompt ?? "";

/** Opens the bot, sends a message and waits until its turn has been delivered. */
async function chatWith(botId: string, text: string, delivered: number) {
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => host.messagesOf(botId).length === delivered);
}

describe("bot profile", () => {
  test("a rename is saved, announced in the bots event and kept when a stale copy of the bot is saved", async () => {
    const id = host.createBot("Ada", "Writes docs");
    const watch = await watchEvents(host);
    const res = await profile(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "Grace", purpose: "Reviews code" });
    expect(getBot(host.dataRoot, id)).toMatchObject({
      name: "Grace",
      purpose: "Reviews code",
      avatar: AVATAR,
    });
    await host.until(() =>
      watch
        .events()
        .some(
          (e) =>
            e.type === "bots" &&
            (e.bots as { id: string; name: string }[]).some(
              (b) => b.id === id && b.name === "Grace",
            ),
        ),
    );
    watch.stop();

    // A chat keeps the bot it read when it opened; saving that copy must not undo the rename.
    const stale = { ...defined(getBot(host.dataRoot, id), "bot"), name: "Ada", purpose: "old" };
    touchBot(host.dataRoot, stale);
    expect(getBot(host.dataRoot, id)).toMatchObject({ name: "Grace", purpose: "Reviews code" });
  });

  test("the next session's system prompt names the bot as renamed", async () => {
    const id = host.createBot("Ada", "Writes docs");
    await chatWith(id, "hello", 1);
    expect(promptOf(0)).toContain('You are "Ada"');
    expect(promptOf(0)).toContain("Your job: Writes docs");

    expect((await profile(id)).status).toBe(200);
    expect((await host.ui("/api/send", { text: "again" })).status).toBe(200);
    await host.until(() => host.launches().length === 2);
    expect(promptOf(1)).toContain('You are "Grace"');
    expect(promptOf(1)).toContain("Your job: Reviews code");
  });

  test("an avatar-only change leaves the running session open", async () => {
    const id = host.createBot("Ada", "Writes docs");
    await chatWith(id, "hello", 1);
    const res = await profile(id, { name: "Ada", purpose: "Writes docs", stroke: "pink" });
    expect(res.status).toBe(200);
    expect(getBot(host.dataRoot, id)?.avatar).toEqual({ face: "crown", stroke: "pink" });
    expect((await host.ui("/api/send", { text: "again" })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 2);
    expect(host.launches()).toHaveLength(1);
  });

  test("an unknown bot answers 404 and an empty name 400", async () => {
    const id = host.createBot("Ada");
    expect((await profile("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await profile(id, { name: "   " })).status).toBe(400);
    expect(getBot(host.dataRoot, id)?.name).toBe("Ada");
  });
});

describe("memory", () => {
  test("the user's memory is written and streamed to the page whichever bot is open", async () => {
    const id = host.createBot("Ada");
    const watch = await watchEvents(host);
    const res = await host.ui("/api/memory/update", { scope: "user", text: "  Prefers tea.  " });
    expect(res.status).toBe(200);
    expect(readMemory(userMemoryPath(host.dataRoot))).toBe("Prefers tea.\n");
    await host.until(() =>
      watch
        .events()
        .some((e) => e.type === "memory" && e.scope === "user" && e.text === "Prefers tea.\n"),
    );
    watch.stop();
    expect(getBot(host.dataRoot, id)).toBeDefined();
  });

  test("a bot's memory is written, and streamed only while that bot is open", async () => {
    const [ada, bob] = [host.createBot("Ada"), host.createBot("Bob")];
    expect((await host.ui("/api/open", { botId: ada })).status).toBe(200);
    const watch = await watchEvents(host);

    expect(
      (await host.ui("/api/memory/update", { scope: "bot", botId: bob, text: "Bob's note" }))
        .status,
    ).toBe(200);
    expect(readMemory(botMemoryPath(host.dataRoot, bob))).toBe("Bob's note\n");
    expect(
      (await host.ui("/api/memory/update", { scope: "bot", botId: ada, text: "Ada's note" }))
        .status,
    ).toBe(200);
    expect(readMemory(botMemoryPath(host.dataRoot, ada))).toBe("Ada's note\n");

    await host.until(() =>
      watch
        .events()
        .some((e) => e.type === "memory" && e.scope === "bot" && e.text === "Ada's note\n"),
    );
    expect(watch.events().some((e) => e.type === "memory" && e.text === "Bob's note\n")).toBe(
      false,
    );
    watch.stop();
  });

  test("an unknown bot answers 404 and writes nothing", async () => {
    const res = await host.ui("/api/memory/update", {
      scope: "bot",
      botId: "00000000-0000-4000-8000-000000000000",
      text: "x",
    });
    expect(res.status).toBe(404);
    expect((await host.ui("/api/memory/update", { scope: "bot", text: "x" })).status).toBe(400);
  });

  test("a saved memory is in the system prompt of the session opened next", async () => {
    const id = host.createBot("Ada");
    await chatWith(id, "hello", 1);
    expect(promptOf(0)).not.toContain("Prefers tea.");

    await host.ui("/api/memory/update", { scope: "user", text: "Prefers tea." });
    await host.ui("/api/memory/update", { scope: "bot", botId: id, text: "Answers in Polish." });
    expect((await host.ui("/api/send", { text: "again" })).status).toBe(200);
    await host.until(() => host.launches().length === 2);
    expect(promptOf(1)).toContain("Prefers tea.");
    expect(promptOf(1)).toContain("Answers in Polish.");
  });
});

describe("instructions", () => {
  const read = async () =>
    Instructions.parse(await (await host.ui("/api/instructions", {})).json());

  test("are empty until saved, then round-trip trimmed in the data root", async () => {
    expect(await read()).toEqual({ text: "" });
    const res = await host.ui("/api/instructions/update", { text: "\n Be brief.  \n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await read()).toEqual({ text: "Be brief.\n" });
    expect(readMemory(instructionsPath(host.dataRoot))).toBe("Be brief.\n");
    expect((await host.ui("/api/instructions/update", { text: "   " })).status).toBe(200);
    expect(await read()).toEqual({ text: "" });
    expect((await host.ui("/api/instructions/update", {})).status).toBe(400);
  });

  test("reach a standard bot's next session under their own heading, and nothing is added when empty", async () => {
    const id = host.createBot("Ada");
    await chatWith(id, "hello", 1);
    expect(promptOf(0)).not.toContain("instructions for every bot");

    await host.ui("/api/instructions/update", { text: "Always answer in Polish." });
    expect((await host.ui("/api/send", { text: "again" })).status).toBe(200);
    await host.until(() => host.launches().length === 2);
    const prompt = promptOf(1);
    expect(prompt).toContain("# The user's instructions for every bot\nAlways answer in Polish.");
    // After the identity block, before the files section.
    expect(prompt.indexOf("# This bot")).toBeLessThan(prompt.indexOf("# The user's instructions"));
    expect(prompt.indexOf("# The user's instructions")).toBeLessThan(
      prompt.indexOf("## Your files"),
    );
  });

  test("reach a double-loop bot's front and its worker", async () => {
    await host.ui("/api/instructions/update", { text: "Always answer in Polish." });
    const id = host.createBot("Dev");
    setChatMode(host.dataRoot, id, "double_loop");
    host.loopScript({ steps: [] });
    await chatWith(id, "hello", 1);

    const launch = defined(host.launches()[0], "launch");
    expect(launch.appendSystemPrompt).toContain("Always answer in Polish.");
    expect(defined(launch.agents?.worker, "worker agent").prompt).toContain(
      "# The user's instructions for every bot\nAlways answer in Polish.",
    );
  });
});

describe("providers", () => {
  const providers = async () =>
    ModelProviders.parse(await (await host.ui("/api/providers", {})).json()).providers;

  test("Claude is connected while the CLI is signed in, with where it runs and the models a bot may pick", async () => {
    const [claude] = await providers();
    expect(claude).toEqual({
      id: "claude",
      name: "Claude",
      vendor: "Anthropic",
      access: "subscription",
      status: "connected",
      detail: `${host.cliPath} (CLAUDE_PATH)`,
      connect: expect.stringContaining("/login"),
      models: ["opus", "sonnet", "haiku"],
    });
  });

  test("the status follows the sign-in as it is now, without a restart", async () => {
    host.setSignedIn(false);
    expect((await providers())[0]?.status).toBe("disconnected");
    host.setSignedIn(true);
    expect((await providers())[0]?.status).toBe("connected");
  });
});
