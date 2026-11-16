import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "../platform/db.ts";
import { fakeChannel } from "../testing/fake-channel.ts";
import { createChannels, type Inbound, type Reply } from "./index.ts";

const owner = { id: "u1", label: "Owner" };
const stranger = { id: "u2", label: "Stranger" };

function setup() {
  let clock = 1_000_000;
  const db = migrate(new Database(":memory:"));
  const fake = fakeChannel();
  const activity = { count: 0 };
  const handled: Inbound[] = [];
  const channels = createChannels({
    db,
    now: () => clock,
    onActivity: () => void activity.count++,
  });
  channels.register(fake.channel);
  channels.handle(async (_kind, inbound) => {
    handled.push(inbound);
    return { toast: "handled" } satisfies Reply;
  });
  const receive = (inbound: Inbound) => channels.receive("fake", inbound);
  const state = () =>
    JSON.stringify([
      db.query("SELECT * FROM channel_links").all(),
      db.query("SELECT channel, expires_at, used_at, failures FROM channel_link_codes").all(),
    ]);
  const link = async (from = owner) => {
    const code = channels.createLinkCode("fake");
    await receive({ from, text: code });
    return code;
  };
  return {
    channels,
    fake,
    receive,
    handled,
    activity,
    state,
    link,
    advance: (ms: number) => (clock += ms),
  };
}

describe("a link code", () => {
  test("is 12 base32 characters in groups of four", () => {
    const { channels } = setup();
    expect(channels.createLinkCode("fake")).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){2}$/);
  });

  test("links the sender from a plain message or from /start, in any case with any separators", async () => {
    for (const write of [
      (c: string) => c,
      (c: string) => `/start ${c}`,
      (c: string) => `/start@claudebot ${c.toLowerCase()}`,
      (c: string) => c.toLowerCase().replaceAll("-", " "),
      (c: string) => ` ${c.replaceAll("-", "_")} `,
    ]) {
      const { channels, receive } = setup();
      const reply = await receive({ from: owner, text: write(channels.createLinkCode("fake")) });
      expect(reply.send).toHaveLength(1);
      expect(channels.linkOf("fake")).toEqual(owner);
    }
  });

  test("works once", async () => {
    const { channels, receive, link } = setup();
    const code = await link();
    expect(channels.linkOf("fake")).toEqual(owner);
    channels.unlink("fake");

    const again = await receive({ from: owner, text: code });
    expect(again.send).toHaveLength(1);
    expect(channels.linkOf("fake")).toBeUndefined();
  });

  test("expires after 10 minutes", async () => {
    const { channels, receive, advance } = setup();
    const code = channels.createLinkCode("fake");
    advance(10 * 60_000 - 1);
    const live = channels.createLinkCode("fake");
    advance(2);
    expect((await receive({ from: owner, text: code })).send).toHaveLength(1);
    expect(channels.linkOf("fake")).toBeUndefined();
    expect((await receive({ from: owner, text: live })).send).toHaveLength(1);
    expect(channels.linkOf("fake")).toEqual(owner);
  });

  test("replaces an earlier link of the channel", async () => {
    const { channels, link } = setup();
    await link(owner);
    await link(stranger);
    expect(channels.linkOf("fake")).toEqual(stranger);
    expect(channels.list()).toEqual([
      { kind: "fake", link: { label: "Stranger", linkedAt: expect.any(Number) } },
    ]);
  });

  test("is refused with a short reply when unknown, and the refusal says nothing about why", async () => {
    const { receive, channels } = setup();
    channels.createLinkCode("fake");
    const wrong = await receive({ from: owner, text: "AAAA-BBBB-CCCC" });
    expect(wrong.send).toHaveLength(1);
    expect(wrong.send![0]!.text.length).toBeLessThan(100);
    expect(channels.linkOf("fake")).toBeUndefined();
  });

  test("ten failed attempts invalidate every outstanding code, and a new code restarts the count", async () => {
    const { channels, receive } = setup();
    const first = channels.createLinkCode("fake");
    const second = channels.createLinkCode("fake");
    for (let i = 0; i < 10; i++) await receive({ from: stranger, text: "AAAA-BBBB-CCCC" });
    await receive({ from: owner, text: first });
    await receive({ from: owner, text: second });
    expect(channels.linkOf("fake")).toBeUndefined();

    const third = channels.createLinkCode("fake");
    for (let i = 0; i < 9; i++) await receive({ from: stranger, text: "AAAA-BBBB-CCCC" });
    await receive({ from: owner, text: third });
    expect(channels.linkOf("fake")).toEqual(owner);
  });

  test("a new code restarts the count of codes already outstanding", async () => {
    const { channels, receive } = setup();
    const first = channels.createLinkCode("fake");
    for (let i = 0; i < 9; i++) await receive({ from: stranger, text: "AAAA-BBBB-CCCC" });
    channels.createLinkCode("fake");
    await receive({ from: stranger, text: "AAAA-BBBB-CCCC" });
    await receive({ from: owner, text: first });
    expect(channels.linkOf("fake")).toEqual(owner);
  });

  test("is not stored, only its digest", async () => {
    const { channels, state } = setup();
    const code = channels.createLinkCode("fake");
    expect(state()).not.toContain(code.replaceAll("-", ""));
  });
});

describe("an update from an account that is not linked", () => {
  test.each([
    ["chatter", { text: "hello there" }],
    ["a command", { text: "/start" }],
    ["a code-length word with a digit outside base32", { text: "abcdefghij18" }],
    ["a long message", { text: "ABCD-EFGH-IJKL ".repeat(20) }],
    ["a button", { button: { data: "a:1", on: "m1" } }],
    ["a reply", { text: "yes", replyTo: "m1" }],
    ["nothing", {}],
  ] satisfies [string, Partial<Inbound>][])(
    "gets no reply and changes nothing: %s",
    async (_name, update) => {
      const { channels, receive, handled, activity, state } = setup();
      channels.createLinkCode("fake");
      const before = state();

      expect(await receive({ from: stranger, ...update })).toEqual({});
      expect(state()).toBe(before);
      expect(handled).toEqual([]);
      expect(activity.count).toBe(0);
    },
  );

  test("is not counted as a failed attempt, so noise cannot burn the codes", async () => {
    const { channels, receive } = setup();
    const code = channels.createLinkCode("fake");
    for (let i = 0; i < 50; i++) await receive({ from: stranger, text: `noise ${i}` });
    await receive({ from: owner, text: code });
    expect(channels.linkOf("fake")).toEqual(owner);
  });
});

describe("an update from the linked account", () => {
  test("goes to the registered handler and counts as activity once, even when it is not a code", async () => {
    const { receive, link, handled, activity } = setup();
    await link();
    expect(activity.count).toBe(0);

    const update: Inbound = { from: owner, text: "hello", replyTo: "m3" };
    expect(await receive(update)).toEqual({ toast: "handled" });
    expect(handled).toEqual([update]);
    expect(activity.count).toBe(1);
  });

  test("is not taken for a link attempt when it carries a code", async () => {
    const { channels, receive, link, handled } = setup();
    await link();
    const code = channels.createLinkCode("fake");
    await receive({ from: owner, text: code });
    expect(handled).toHaveLength(1);
    // The code was never spent: another account can still use it.
    await receive({ from: stranger, text: code });
    expect(channels.linkOf("fake")).toEqual(stranger);
  });

  test("gets an empty reply before any handler is registered", async () => {
    const db = migrate(new Database(":memory:"));
    const channels = createChannels({ db, onActivity: () => {} });
    channels.register(fakeChannel().channel);
    await channels.receive("fake", { from: owner, text: channels.createLinkCode("fake") });
    expect(await channels.receive("fake", { from: owner, text: "hi" })).toEqual({});
  });
});

describe("sending to the linked account", () => {
  test("sends and edits through the adapter", async () => {
    const { channels, fake, link } = setup();
    await link();
    const sent = await channels.send("fake", { text: "one" });
    expect(sent).toEqual({ delivered: true, ref: "m1" });
    expect(fake.sent).toMatchObject([{ to: owner, message: { text: "one" } }]);

    await channels.edit("fake", "m1", { text: "two" });
    expect(fake.edited).toEqual([{ ref: "m1", message: { text: "two" } }]);
  });

  test("with no link is a no-op that reports it", async () => {
    const { channels, fake } = setup();
    expect(await channels.send("fake", { text: "one" })).toEqual({ delivered: false });
    expect(fake.sent).toEqual([]);
  });

  test("unlinking deletes the link, so sending is a no-op again", async () => {
    const { channels, link } = setup();
    await link();
    expect(channels.unlink("fake")).toBe(true);
    expect(channels.unlink("fake")).toBe(false);
    expect(await channels.send("fake", { text: "one" })).toEqual({ delivered: false });
  });
});

describe("the registry", () => {
  test("keys channels by kind, starts and stops each, and refuses a second of the same kind", async () => {
    const { channels, fake } = setup();
    const other = fakeChannel("other");
    channels.register(other.channel);
    expect(() => channels.register(fakeChannel().channel)).toThrow("already registered");
    expect(channels.list().map((c) => c.kind)).toEqual(["fake", "other"]);

    channels.start();
    await channels.stop();
    expect([fake.started(), fake.stopped(), other.started(), other.stopped()]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test("links are per channel", async () => {
    const { channels, link } = setup();
    channels.register(fakeChannel("other").channel);
    await link();
    expect(channels.linkOf("other")).toBeUndefined();
    expect(await channels.send("other", { text: "x" })).toEqual({ delivered: false });
  });

  test("an unknown kind is refused", async () => {
    const { channels } = setup();
    expect(() => channels.createLinkCode("nope")).toThrow("no such channel");
    expect(() => channels.unlink("nope")).toThrow("no such channel");
    expect(channels.receive("nope", { from: owner, text: "x" })).rejects.toThrow("no such channel");
  });
});
