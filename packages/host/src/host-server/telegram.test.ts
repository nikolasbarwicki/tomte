import { afterEach, describe, expect, test } from "bun:test";

import { ChannelLinkCodeResponse, ChannelList } from "@tomte/contract/api";

import { fakeTelegram, type FakeTelegram, type TelegramUser } from "../testing/fake-telegram.ts";
import { clientPost } from "../testing/paired-device.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

const hosts: HandoffHost[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const f of fakes.splice(0)) await f.stop();
});

const owner: TelegramUser = { id: 4242, first_name: "Owner", last_name: "One" };
const other: TelegramUser = { id: 777, first_name: "Other" };
const stranger: TelegramUser = { id: 999, first_name: "Stranger" };
const SPACING_MS = 40;

async function start(tg = fakeTelegram(), timing: { pollTimeoutSeconds?: number } = {}) {
  fakes.push(tg);
  const host = await startHandoffHost([], undefined, undefined, {
    telegram: {
      baseUrl: tg.url,
      pollTimeoutSeconds: timing.pollTimeoutSeconds ?? 30,
      sendSpacingMs: SPACING_MS,
      backoffMs: 20,
    },
  });
  hosts.push(host);
  const post = (path: string, body: object = {}) =>
    clientPost(host.server, host.deviceToken, path, body);
  const setToken = (token: string) => post("/api/channels/telegram/token", { token });
  const entry = async () => {
    const res = await post("/api/channels/list");
    expect(res.status).toBe(200);
    return ChannelList.parse(await res.json()).find((c) => c.kind === "telegram")!;
  };
  const linkCode = async () => {
    const res = await post("/api/channels/link-code", { channel: "telegram" });
    expect(res.status).toBe(200);
    return ChannelLinkCodeResponse.parse(await res.json());
  };
  /** Waits until the adapter has confirmed the update (its next poll asks for a later offset), so what it did about it is done. */
  const handled = (id: number) =>
    host.until(() =>
      tg.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
    );
  /** A started host with the fake's token set and the poll running. */
  const running = async () => {
    expect((await setToken(tg.token)).status).toBe(200);
    await host.until(() => tg.of("getUpdates").length > 0);
  };
  return { tg, host, post, setToken, entry, linkCode, handled, running };
}

describe("the Telegram bot token route", () => {
  test("needs a device token", async () => {
    const { host } = await start();
    const res = await fetch(`${host.clientUrl}/api/channels/telegram/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host.clientUrl },
      body: JSON.stringify({ token: "123:fake-token" }),
    });
    expect(res.status).toBe(401);
  });

  test("a token Telegram accepts is stored under its own name, starts polling and is never shown", async () => {
    const { tg, host, setToken, entry } = await start();
    expect(await entry()).toMatchObject({ status: { state: "unconfigured" } });
    const events = await watchEvents(host);

    const res = await setToken(tg.token);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(tg.token);

    expect(host.secretNames()).toContain("channel-token:telegram");
    await host.until(() => tg.of("getUpdates").length > 0);
    expect(await entry()).toMatchObject({
      status: { state: "running", detail: null, username: tg.username },
    });

    const poll = tg.of("getUpdates")[0]!;
    expect(poll.params.timeout).toBe(30);
    expect(poll.params.allowed_updates).toEqual(["message", "callback_query"]);

    const listed = await (await host.ui("/api/channels/list", {})).text();
    expect(listed).not.toContain(tg.token);
    await host.ui("/api/channels/link-code", { channel: "telegram" });
    expect(JSON.stringify(events.events())).not.toContain(tg.token);
    events.stop();
  });

  test("a token Telegram rejects is not stored and starts nothing", async () => {
    const { tg, host, setToken, entry } = await start();
    const res = await setToken("123:wrong-token");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("rejected");
    expect(host.secretNames()).not.toContain("channel-token:telegram");
    expect(tg.of("getMe")).toHaveLength(1);
    expect(tg.of("getUpdates")).toHaveLength(0);
    expect(await entry()).toMatchObject({ status: { state: "unconfigured" } });
    expect((await setToken("   ")).status).toBe(400);
  });

  test("a token Telegram cannot be asked about is refused with 502 and not stored", async () => {
    const dead = fakeTelegram();
    const { tg, host, setToken } = await start(dead);
    await tg.stop();
    const res = await setToken(tg.token);
    expect(res.status).toBe(502);
    expect(host.secretNames()).not.toContain("channel-token:telegram");
  });

  test("a second call replaces the token: the old poll ends and the new token polls, also after a restart", async () => {
    const { tg, host, setToken, entry } = await start();
    expect((await setToken(tg.token)).status).toBe(200);
    await host.until(() => tg.of("getUpdates").length > 0);

    const second = "456:other-fake-token";
    tg.allow(second);
    expect((await setToken(second)).status).toBe(200);
    await host.until(() => tg.of("getUpdates").some((c) => c.token === second));
    // The first loop is aborted, so the first token is not used again.
    const mark = tg.calls.length;
    await Bun.sleep(150);
    expect(tg.calls.slice(mark).filter((c) => c.token === tg.token)).toEqual([]);
    expect(host.secretNames().filter((n) => n === "channel-token:telegram")).toHaveLength(1);

    await host.restart();
    const restarted = tg.calls.length;
    await host.until(() => tg.calls.slice(restarted).some((c) => c.method === "getUpdates"));
    expect(tg.calls.slice(restarted).every((c) => c.token === second)).toBe(true);
    expect((await entry()).status.state).toBe("running");
  });

  test("unlinking keeps the token", async () => {
    const { tg, host, post, linkCode, running, handled } = await start();
    await running();
    const { code } = await linkCode();
    await handled(tg.message(owner, code));
    expect((await post("/api/channels/unlink", { channel: "telegram" })).status).toBe(200);
    expect(host.secretNames()).toContain("channel-token:telegram");
  });
});

describe("polling", () => {
  test("starts with the host when a token is stored and stops when it closes", async () => {
    const { tg, host, running } = await start();
    await running();
    await host.restart();
    const before = tg.of("getUpdates").length;
    await host.until(() => tg.of("getUpdates").length > before);

    const started = Date.now();
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    // The 30 s long poll is aborted, not waited out.
    expect(Date.now() - started).toBeLessThan(5000);
    const after = tg.calls.length;
    await Bun.sleep(150);
    expect(tg.calls.length).toBe(after);
  });

  test("a revoked token (401) stops polling, is reported, and setting a token restarts it", async () => {
    const { tg, host, setToken, entry, running } = await start();
    await running();
    tg.revoke();
    await host.until(() => tg.of("getUpdates").some((c) => !c.authorized));
    await expectStatus(entry, { state: "failed", detail: "the bot token was rejected" });

    const polls = tg.calls.length;
    await Bun.sleep(150);
    expect(tg.calls.length).toBe(polls);

    const fresh = "789:fresh-fake-token";
    tg.allow(fresh);
    expect((await setToken(fresh)).status).toBe(200);
    await expectStatus(entry, { state: "running", detail: null });
  });

  test("a conflict (409) is reported as such, polling goes on, and it clears when the other poller is gone", async () => {
    const { tg, entry, running } = await start();
    await running();
    tg.conflict();
    await expectStatus(entry, {
      state: "failed",
      detail: "another process polls this bot or a webhook is set",
    });
    const polls = tg.of("getUpdates").length;
    await Bun.sleep(200);
    expect(tg.of("getUpdates").length).toBeGreaterThan(polls);

    tg.conflict(false);
    await expectStatus(entry, { state: "running", detail: null });
  });

  test("failed calls back off, the wait doubling", async () => {
    const { tg, host, entry, running } = await start();
    await running();
    tg.conflict();
    await expectStatus(entry, { state: "failed" });
    const mark = tg.of("getUpdates").length;
    await host.until(() => tg.of("getUpdates").length >= mark + 5);
    const times = tg
      .of("getUpdates")
      .slice(mark)
      .map((c) => c.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]!);
  });
});

async function expectStatus(
  entry: () => Promise<{ status: { state: string; detail: string | null } }>,
  want: { state: string; detail?: string | null },
) {
  const deadline = Date.now() + 5000;
  let last: unknown;
  while (Date.now() < deadline) {
    last = (await entry()).status;
    if (JSON.stringify(last) === JSON.stringify({ ...(last as object), ...want })) return;
    await Bun.sleep(20);
  }
  expect(last).toMatchObject(want);
}

describe("linking", () => {
  test("a code sent as /start <code> links that account, confirms in its chat, and the page gets the deep link", async () => {
    const { tg, entry, linkCode, running, handled } = await start();
    await running();
    const { code, url } = await linkCode();
    expect(url).toBe(`https://t.me/${tg.username}?start=${code}`);

    await handled(tg.message(owner, `/start ${code}`));
    expect(tg.texts()).toHaveLength(1);
    expect(tg.of("sendMessage")[0]!.params.chat_id).toBe(owner.id);
    expect((await entry()).link).toMatchObject({ label: "Owner One" });
  });

  test("a code sent as a plain message links too, and is used once", async () => {
    const { tg, entry, linkCode, running, handled } = await start();
    await running();
    const { code } = await linkCode();
    await handled(tg.message(owner, code.toLowerCase().replaceAll("-", " ")));
    expect((await entry()).link).toMatchObject({ label: "Owner One" });

    await handled(tg.message(other, code));
    expect((await entry()).link).toMatchObject({ label: "Owner One" });
    // The linked account's second message is not a code attempt and gets nothing; the stranger with a spent code is refused once.
    expect(tg.of("sendMessage").map((c) => c.params.chat_id)).toEqual([owner.id, other.id]);
  });

  test("a second account sending a valid code later replaces the link; before that it gets nothing", async () => {
    const { tg, entry, linkCode, running, handled } = await start();
    await running();
    await handled(tg.message(owner, (await linkCode()).code));
    const sends = tg.of("sendMessage").length;

    await handled(tg.message(other, "hello"));
    await handled(tg.message(other, "/start"));
    expect(tg.of("sendMessage")).toHaveLength(sends);
    expect((await entry()).link).toMatchObject({ label: "Owner One" });

    await handled(tg.message(other, (await linkCode()).code));
    expect((await entry()).link).toMatchObject({ label: "Other" });
    expect(tg.of("sendMessage").at(-1)!.params.chat_id).toBe(other.id);
  });

  test("nothing from an account that is not linked gets any call back, whatever the update is", async () => {
    const { tg, entry, linkCode, running, handled } = await start();
    await running();
    await linkCode();
    const ids = [
      tg.message(stranger, "hello"),
      tg.message(stranger, "/start"),
      tg.message(stranger, "ABCD-EFGH-IJKA", { chatType: "group", chatId: -100 }),
      tg.message(stranger, "hi", { chatType: "channel", chatId: -200 }),
      tg.press(stranger, "approve:1", 5),
      tg.editedMessage(stranger, "edited"),
      tg.push({ message: { message_id: 1, chat: { id: 5, type: "private" }, text: "no sender" } }),
      tg.push({ my_chat_member: { chat: { id: 1 } } }),
    ];
    await handled(ids.at(-1)!);
    expect(tg.outgoing()).toEqual([]);
    expect((await entry()).link).toBeNull();
  });

  test("a linked account's group messages, edits and button presses are served only in its private chat", async () => {
    const { tg, linkCode, running, handled } = await start();
    await running();
    await handled(tg.message(owner, (await linkCode()).code));
    const sends = tg.outgoing().length;
    const id = tg.message(owner, "hi", { chatType: "supergroup", chatId: -300 });
    tg.editedMessage(owner, "edited");
    await handled(id + 1);
    expect(tg.outgoing()).toHaveLength(sends);
  });

  test("a code the host never made links nothing and says so once per attempt", async () => {
    const { tg, entry, linkCode, running, handled } = await start();
    await running();
    await linkCode();
    await handled(tg.message(stranger, "ABCD-EFGH-IJKL"));
    expect((await entry()).link).toBeNull();
    expect(tg.texts()).toHaveLength(1);
  });
});

describe("sending", () => {
  const sendTo = (host: HandoffHost, text: string) =>
    host.server.channels.send("telegram", { text });

  test("is plain text with link previews off, and a long message is cut below the limit", async () => {
    const { tg, host, linkCode, running, handled } = await start();
    await running();
    await handled(tg.message(owner, (await linkCode()).code));

    const long = `${"x".repeat(5000)}`;
    expect(await sendTo(host, long)).toMatchObject({ delivered: true });
    const call = tg.of("sendMessage").at(-1)!;
    expect(call.params.parse_mode).toBeUndefined();
    expect(call.params.link_preview_options).toEqual({ is_disabled: true });
    const text = String(call.params.text);
    expect(text.length).toBeLessThan(4096);
    expect(text.endsWith("…")).toBe(true);
  });

  test("a 429 with retry_after is waited out and retried once", async () => {
    const { tg, host, linkCode, running, handled } = await start();
    await running();
    await handled(tg.message(owner, (await linkCode()).code));
    const before = tg.texts().length;

    tg.rateLimit(1, 1);
    const started = Date.now();
    const sent = await sendTo(host, "after the wait");
    expect(sent).toMatchObject({ delivered: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(
      tg
        .of("sendMessage")
        .slice(-2)
        .map((c) => c.status),
    ).toEqual([429, 200]);
    expect(tg.texts().slice(before)).toEqual(["after the wait"]);
  });

  test("a burst is all delivered, in order, with the sends spaced", async () => {
    const { tg, host, linkCode, running, handled } = await start();
    await running();
    await handled(tg.message(owner, (await linkCode()).code));
    const mark = tg.of("sendMessage").length;

    const texts = Array.from({ length: 6 }, (_, i) => `card ${i + 1}`);
    await Promise.all(texts.map((t) => sendTo(host, t)));
    const calls = tg.of("sendMessage").slice(mark);
    expect(calls.map((c) => c.params.text)).toEqual(texts);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(SPACING_MS - 10);
  });

  test("a message to an account that is not linked is not delivered", async () => {
    const { tg, host, running } = await start();
    await running();
    expect(await sendTo(host, "hi")).toEqual({ delivered: false });
    expect(tg.outgoing()).toEqual([]);
  });
});

describe("the update offset", () => {
  test("advances after an update is handled, and a restart handles at most the unconfirmed ones again, with no second effect", async () => {
    const { tg, host, entry, linkCode, running, handled } = await start();
    await running();
    const { code } = await linkCode();
    const id = tg.message(owner, `/start ${code}`);
    await handled(id);
    const polls = tg.of("getUpdates");
    expect(polls.at(-1)!.params.offset).toBe(id + 1);
    expect(tg.texts()).toHaveLength(1);

    // As if Telegram never saw the offset that confirmed it.
    tg.forgetConfirmations();
    const mark = tg.calls.length;
    await host.restart();
    await host.until(() =>
      tg.calls
        .slice(mark)
        .some(
          (c) =>
            c.method === "getUpdates" &&
            typeof c.params.offset === "number" &&
            c.params.offset > id,
        ),
    );
    // The first poll after the restart asked for everything, so it re-read the update.
    expect(
      tg.calls.slice(mark).find((c) => c.method === "getUpdates")!.params.offset,
    ).toBeUndefined();
    // The code is plain words from the linked account now, which no card takes: the one new message is the hint, never a second link.
    expect(tg.texts()).toHaveLength(2);
    expect(tg.texts()[1]).toContain("To talk to a bot");
    expect((await entry()).link).toMatchObject({ label: "Owner One" });
  });
});
