import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { ChannelLinkCodeResponse } from "@claudebot/contract/api";

import { fakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const DAY = 24 * 60 * 60_000;
const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const hosts: HandoffHost[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const f of fakes.splice(0)) await f.stop();
});

type Run = { id: string; status: string; error: string | null };

/** A host with a fake Telegram, optionally linked to the owner, and a routine on a bot whose chat is not the open one (so its runs are headless). */
async function start({ linked = true, hostFlags = [] as string[] } = {}) {
  const tg = fakeTelegram();
  fakes.push(tg);
  const host = await startHandoffHost(hostFlags, undefined, undefined, {
    telegram: { baseUrl: tg.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    cards: { retryMs: 30 },
    notices: { retryMs: 20 },
  });
  hosts.push(host);

  if (linked) {
    expect((await host.ui("/api/channels/telegram/token", { token: tg.token })).status).toBe(200);
    await host.until(() => tg.of("getUpdates").length > 0);
    const res = await host.ui("/api/channels/link-code", { channel: "telegram" });
    const { code } = ChannelLinkCodeResponse.parse(await res.json());
    const id = tg.message(owner, code);
    await host.until(() =>
      tg.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
    );
    await host.until(() => tg.texts().length === 1);
  }
  const confirmations = tg.texts().length;
  /** What the host sent after the link confirmation that is not a card: the routine's question is also a card for the owner, which these tests are not about. */
  const notices = () =>
    tg
      .texts()
      .slice(confirmations)
      .filter((text) => !text.startsWith("Planner asks:"));

  const botId = host.createBot("Planner");
  const other = host.createBot("Other");
  expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "do it",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routineId = ((await created.json()) as { id: string }).id;

  const runs = async () =>
    (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];
  const untilRun = async (status: string) => {
    for (let i = 0; i < 200 && (await runs())[0]?.status !== status; i++) await Bun.sleep(25);
    expect((await runs())[0]?.status).toBe(status);
  };
  const startRun = async () => {
    const res = await host.ui("/api/routines/run", { id: routineId });
    expect(res.status).toBe(200);
  };
  /** Gives a message the time to arrive, then says what was sent: a notice that was not sent would show up late, not never. */
  const settle = async () => {
    await Bun.sleep(300);
    return notices();
  };
  return { tg, host, botId, routineId, runs, untilRun, startRun, notices, settle };
}

describe("a failed run", () => {
  test("sends one notice with the error, even when the routine never asked for results", async () => {
    const t = await start();
    // The CLI dies after calling ask_user, so the turn fails.
    t.host.askOnMessage("Which list?", undefined, { crash: true });
    await t.startRun();
    await t.untilRun("failed");
    const error = (await t.runs())[0]!.error!;
    await t.host.until(() => t.notices().length > 0);
    expect(await t.settle()).toEqual([`Routine nightly failed: ${error}`]);
    // No link on a loopback public URL, and no buttons: it is a message, not a card.
    expect(t.tg.of("sendMessage").at(-1)?.params.reply_markup).toBeUndefined();
  });

  test("links to the bot's routines panel when the public URL is not loopback", async () => {
    const t = await start({ hostFlags: ["--public-url", "https://claudebot.example.com"] });
    t.host.askOnMessage("Which list?", undefined, { crash: true });
    await t.startRun();
    await t.host.until(() => t.notices().length > 0);
    const markup = t.tg.of("sendMessage").at(-1)?.params.reply_markup as {
      inline_keyboard: { text: string; url?: string }[][];
    };
    expect(markup.inline_keyboard.flat()).toEqual([
      {
        text: "Open in Claudebot",
        url: `https://claudebot.example.com/bots/${t.botId}?panel=routines`,
      },
    ]);
  });

  test("with no linked account sends nothing and the run still ends failed", async () => {
    const t = await start({ linked: false });
    t.host.askOnMessage("Which list?", undefined, { crash: true });
    await t.startRun();
    await t.untilRun("failed");
    expect(await t.settle()).toEqual([]);
    expect(t.tg.of("sendMessage")).toEqual([]);
  });

  test("on a bot that no longer exists is recorded and not sent", async () => {
    const t = await start();
    rmSync(join(t.host.dataRoot, "bots", t.botId, "bot.json"));
    await t.startRun();
    await t.untilRun("failed");
    expect((await t.runs())[0]?.error).toBe("bot no longer exists");
    expect(await t.settle()).toEqual([]);
  });
});

describe("a run that ends well", () => {
  test("sends nothing", async () => {
    const t = await start();
    await t.startRun();
    await t.untilRun("succeeded");
    expect(await t.settle()).toEqual([]);
  });
});

describe("a run the host's stopping interrupted", () => {
  test("is reported once after the restart, worded as interrupted", async () => {
    const t = await start();
    t.host.hold();
    await t.startRun();
    await t.untilRun("running");
    await t.host.restart();
    await t.untilRun("interrupted");
    await t.host.until(() => t.notices().length > 0);
    expect(await t.settle()).toEqual(["Routine nightly was interrupted: app stopped during run"]);
    // Another start has nothing more to report.
    await t.host.restart();
    expect(await t.settle()).toHaveLength(1);
  });
});

describe("a park that expires", () => {
  test("sends park_expired and not also a failure", async () => {
    const t = await start();
    t.host.askOnMessage("Which list?");
    await t.startRun();
    await t.untilRun("waiting");
    t.host.stopAsking();

    t.host.advanceClock(DAY + 1000);
    await t.host.restart();
    await t.untilRun("failed");
    expect((await t.runs())[0]?.error).toBe("approval expired");
    await t.host.until(() => t.notices().length > 0);
    expect(await t.settle()).toEqual([
      'nightly: question "Which list?" expired, so the run failed',
    ]);
  });
});
