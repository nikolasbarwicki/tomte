import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startHandoffHost, parse, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

const BRIEF = "Goal: g. Context: none. Constraints: none. Deliverable: d. Done when: done.";

async function open() {
  const a = host.createBot("Alice", "plans");
  const b = host.createBot("Bob", "searches");
  const alice = await host.actAs(a);
  const bob = await host.actAs(b);
  const { handoff_id } = parse<{ handoff_id: string }>(
    await alice.call("hand_off", { to: b, title: "T", brief: BRIEF }),
  );
  await host.until(() => host.messagesOf(b).length === 1);
  return { a, b, alice, bob, handoff_id };
}

describe("restart", () => {
  test("a working handoff re-delivers the brief to the assignee, resumed", async () => {
    const { b, handoff_id } = await open();
    await host.restart();
    await host.until(() => host.messagesOf(b).length === 2);
    expect(host.messagesOf(b)[1]).toContain(
      `<handoff id="${handoff_id}" requester="Alice" title="T" resumed="true">`,
    );
    expect(host.messagesOf(b)[1]).toContain(BRIEF);
  });

  test("an input-required handoff re-delivers the question to the requester", async () => {
    const { a, bob, handoff_id } = await open();
    await bob.call("handoff_message", { handoff_id, text: "Which region?" });
    await host.until(() => host.messagesOf(a).length === 1);
    await host.restart();
    await host.until(() => host.messagesOf(a).length === 2);
    expect(host.messagesOf(a)[1]).toContain(`resumed="true"`);
    expect(host.messagesOf(a)[1]).toContain("Which region?");
  });

  test("finished handoffs are not re-delivered", async () => {
    const { a, b, bob, handoff_id } = await open();
    await bob.call("complete_handoff", { handoff_id, result: "done" });
    await host.until(() => host.messagesOf(a).length === 1);
    await host.restart();
    await Bun.sleep(300);
    expect(host.messagesOf(a)).toHaveLength(1);
    expect(host.messagesOf(b)).toHaveLength(1);
  });
});

describe("removing a bot", () => {
  test("fails its open handoffs in both roles and tells each other party", async () => {
    const { a, b, alice, handoff_id } = await open();
    const c = host.createBot("Cara", "writes");
    const bob = await host.actAs(b);
    const second = parse<{ handoff_id: string }>(
      await bob.call("hand_off", { to: c, title: "U", brief: BRIEF }),
    );
    await host.until(() => host.messagesOf(c).length === 1);

    await host.server.removeBot(b);
    await host.until(() => host.messagesOf(a).length === 1 && host.messagesOf(c).length === 2);
    expect(host.messagesOf(a)[0]).toContain(
      `<handoff-update id="${handoff_id}" from="Bob" status="failed">`,
    );
    expect(host.messagesOf(c)[1]).toContain(
      `<handoff-update id="${second.handoff_id}" from="Bob" status="failed">`,
    );
    const again = await alice.call("cancel_handoff", { handoff_id, reason: "x" });
    expect(again.isError).toBe(true);
  });
});
