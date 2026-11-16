import { afterEach, describe, expect, test } from "bun:test";

import { ChannelLinkCodeResponse, ChannelList } from "@claudebot/contract/api";

import { fakeChannel, type FakeChannel } from "../testing/fake-channel.ts";
import { clientPost } from "../testing/paired-device.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const hosts: HandoffHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

const owner = { id: "u1", label: "Owner" };

async function start() {
  const fake = fakeChannel();
  const host = await startHandoffHost([], undefined, undefined, {
    channelAdapters: (receive) => fake.adapters(receive),
  });
  hosts.push(host);
  const post = (path: string, body: object = {}) =>
    clientPost(host.server, host.deviceToken, path, body);
  const list = async () => {
    const res = await post("/api/channels/list");
    expect(res.status).toBe(200);
    // The host always runs Telegram too (its own tests are telegram.test.ts); these tests are about the fake channel.
    return ChannelList.parse(await res.json()).filter((c) => c.kind === "fake");
  };
  const linkCode = async () => {
    const res = await post("/api/channels/link-code", { channel: "fake" });
    expect(res.status).toBe(200);
    return ChannelLinkCodeResponse.parse(await res.json()).code;
  };
  return { host, fake, post, list, linkCode };
}

const sentTo = (fake: FakeChannel) => fake.sent.map((s) => s.message.text);

describe("the channel routes", () => {
  test("need a device token like every other API route", async () => {
    const { host } = await start();
    for (const path of ["/api/channels/list", "/api/channels/link-code", "/api/channels/unlink"]) {
      const res = await fetch(`${host.clientUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: host.clientUrl },
        body: JSON.stringify({ channel: "fake" }),
      });
      expect(res.status).toBe(401);
    }
  });

  test("list every registered channel as not linked at first", async () => {
    const { list } = await start();
    expect(await list()).toEqual([
      { kind: "fake", link: null, status: { state: "running", detail: null, username: null } },
    ]);
  });

  test("a code sent as the channel's account links it, and the page's list shows the account", async () => {
    const { fake, list, linkCode, host } = await start();
    const code = await linkCode();
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){2}$/);

    const before = Date.now();
    const reply = await fake.inject({ from: owner, text: `/start ${code}` });
    expect(reply.send).toHaveLength(1);

    const [entry] = await list();
    expect(entry).toEqual({
      kind: "fake",
      link: { label: "Owner", linkedAt: expect.any(Number) },
      status: { state: "running", detail: null, username: null },
    });
    expect(entry!.link!.linkedAt).toBeGreaterThanOrEqual(before - 1000);

    // Used once: the same code from another account links nothing.
    await fake.inject({ from: { id: "u2", label: "Other" }, text: code });
    expect((await list())[0]!.link!.label).toBe("Owner");
    expect(host.server.channels.linkOf("fake")).toEqual(owner);
  });

  test("the code expires after 10 minutes", async () => {
    const { fake, list, linkCode, host } = await start();
    const code = await linkCode();
    host.advanceClock(10 * 60_000 + 1);
    await fake.inject({ from: owner, text: code });
    expect((await list())[0]!.link).toBeNull();
  });

  test("a stranger's messages reach nothing: no reply, no link, no message to any bot", async () => {
    const { host, fake, list, linkCode } = await start();
    const botId = host.createBot("Echo");
    await linkCode();

    for (const text of ["hello", "/start", "please run the tests"])
      expect(await fake.inject({ from: { id: "u9", label: "Stranger" }, text })).toEqual({});
    expect((await list())[0]!.link).toBeNull();
    expect(host.messagesOf(botId)).toEqual([]);
    expect(sentTo(fake)).toEqual([]);
  });

  test("unlink deletes the link, and the account can no longer be sent to", async () => {
    const { host, fake, post, list, linkCode } = await start();
    await fake.inject({ from: owner, text: await linkCode() });
    expect(await host.server.channels.send("fake", { text: "hi" })).toMatchObject({
      delivered: true,
    });

    const res = await post("/api/channels/unlink", { channel: "fake" });
    expect(await res.json()).toEqual({ ok: true });
    expect((await list())[0]!.link).toBeNull();
    expect(await host.server.channels.send("fake", { text: "hi" })).toEqual({ delivered: false });
    expect(sentTo(fake)).toEqual(["hi"]);
  });

  test("the link survives a host restart", async () => {
    const { host, fake, list, linkCode } = await start();
    await fake.inject({ from: owner, text: await linkCode() });
    await host.restart();
    expect((await list())[0]!.link!.label).toBe("Owner");
  });

  test("an unknown channel is a 404 and a missing channel name a 400", async () => {
    const { post } = await start();
    expect((await post("/api/channels/link-code", { channel: "nope" })).status).toBe(404);
    expect((await post("/api/channels/unlink", { channel: "nope" })).status).toBe(404);
    expect((await post("/api/channels/link-code", {})).status).toBe(400);
    expect((await post("/api/channels/other")).status).toBe(404);
  });

  test("the channels start with the host and stop when it closes", async () => {
    const { host, fake } = await start();
    expect([fake.started(), fake.stopped()]).toEqual([1, 0]);
    await host.restart();
    expect([fake.started(), fake.stopped()]).toEqual([2, 1]);
  });
});
