import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { hostname } from "node:os";

import { ChannelLinkCodeResponse } from "@tomte/contract/api";

import { fakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

setDefaultTimeout(60_000);

const owner = { id: 4242, first_name: "Owner", last_name: "One" };
let host: HandoffHost | undefined;
let tg: FakeTelegram | undefined;
let watcher: EventsWatch | undefined;
afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await host?.stop();
  await tg?.stop();
  host = undefined;
  tg = undefined;
});

/** A host with no bots at all, whose owner is linked on a fake Telegram and watches the page's stream. */
async function start(hostFlags: string[] = []) {
  tg = fakeTelegram();
  const t = tg;
  const h = await startHandoffHost(hostFlags, undefined, undefined, {
    telegram: { baseUrl: t.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    notices: { retryMs: 20 },
  });
  host = h;
  watcher = await watchEvents(h);
  const w = watcher;
  await h.until(() => w.hostStatus()?.claude.state === "signed-in");

  expect((await h.ui("/api/channels/telegram/token", { token: t.token })).status).toBe(200);
  await h.until(() => t.of("getUpdates").length > 0);
  const { code } = ChannelLinkCodeResponse.parse(
    await (await h.ui("/api/channels/link-code", { channel: "telegram" })).json(),
  );
  const id = t.message(owner, code);
  await h.until(() =>
    t.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
  );
  await h.until(() => t.texts().length === 1);

  /** The CLI's sign-in changed outside the host; asking again is what makes the host see it. */
  const recheck = async (signedIn: boolean) => {
    h.setSignedIn(signedIn);
    expect((await h.ui("/api/providers", {})).status).toBe(200);
    await h.until(() => w.hostStatus()?.claude.state === (signedIn ? "signed-in" : "signed-out"));
  };
  /** What the host sent after the link confirmation, after giving a message that was not sent the time to arrive. */
  const sent = async () => {
    await Bun.sleep(300);
    return t.texts().slice(1);
  };
  return { h, w, recheck, sent };
}

test("a host with no bots shows the problem on the stream and tells the owner once", async () => {
  const { w, recheck, sent } = await start();
  expect(w.hostStatus()?.problems).toEqual([]);

  await recheck(false);

  expect(w.hostStatus()?.problems).toEqual([{ kind: "claude-signed-out" }]);
  const messages = await sent();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(hostname());
  expect(messages[0]).toContain("Claude is signed out");
});

test("a signed-out host sends one message per episode: none for a repeated check, one more after it signed in and out again", async () => {
  const { w, recheck, sent } = await start();

  await recheck(false);
  expect(await sent()).toHaveLength(1);

  // Asked again, and again by the host's own timer-free triggers: the cause is the same, so nothing is sent.
  expect((await host!.ui("/api/providers", {})).status).toBe(200);
  expect((await host!.ui("/api/providers", {})).status).toBe(200);
  expect(await sent()).toHaveLength(1);
  expect(w.hostStatus()?.problems).toHaveLength(1);

  await recheck(true);
  expect(w.hostStatus()?.problems).toEqual([]);
  expect(await sent()).toHaveLength(1);

  await recheck(false);
  expect(w.hostStatus()?.problems).toEqual([{ kind: "claude-signed-out" }]);
  expect(await sent()).toHaveLength(2);
});

test("a long-lived token the API refuses is told once to the owner, with what to do", async () => {
  const { h, w, sent } = await start();
  const token = "sk-ant-oat01-fake_synthetic-token";
  expect((await h.ui("/api/providers/claude/token", { token })).status).toBe(200);
  h.setInvalidToken(token);
  const bot = h.createBot("Ada");
  expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await h.ui("/api/send", { text: "hello" })).status).toBe(200);

  await h.until(() => w.hostStatus()?.problems.length === 1);
  expect(w.hostStatus()?.problems).toEqual([
    { kind: "claude-signed-out", reason: "token-rejected" },
  ]);
  const messages = await sent();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Claude rejected the long-lived token");
  expect(messages[0]).toContain("Replace it in Settings, Models");
});

test("the message links to Settings when the public URL is not loopback", async () => {
  const { recheck, sent } = await start(["--public-url", "https://tomte.example.com"]);
  await recheck(false);
  const messages = await sent();
  expect(messages[0]).toStartWith("tomte.example.com: Claude is signed out");
  const markup = tg!.of("sendMessage").at(-1)?.params.reply_markup as {
    inline_keyboard: { text: string; url?: string }[][];
  };
  expect(markup.inline_keyboard.flat()).toEqual([
    { text: "Open in Tomte", url: "https://tomte.example.com/settings/models" },
  ]);
});
