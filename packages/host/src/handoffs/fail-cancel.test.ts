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

describe("fail_handoff", () => {
  test("declining a submitted handoff delivers the reason to the requester", async () => {
    const { a, bob, handoff_id } = await open();
    expect(parse(await bob.call("fail_handoff", { handoff_id, reason: "not my area" }))).toEqual({
      handoff_id,
      status: "failed",
    });
    await host.until(() => host.messagesOf(a).length === 1);
    expect(host.messagesOf(a)[0]).toContain(
      `<handoff-update id="${handoff_id}" from="Bob" status="failed">`,
    );
    expect(host.messagesOf(a)[0]).toContain("not my area");
  });
});

describe("cancel_handoff", () => {
  test("tells the assignee to stop", async () => {
    const { b, alice, handoff_id } = await open();
    expect(
      parse(await alice.call("cancel_handoff", { handoff_id, reason: "no longer needed" })),
    ).toEqual({ handoff_id, status: "canceled" });
    await host.until(() => host.messagesOf(b).length === 2);
    expect(host.messagesOf(b)[1]).toContain(`status="canceled"`);
    expect(host.messagesOf(b)[1]).toContain("no longer needed");
  });
});

describe("roles", () => {
  test("requester cannot complete or fail; assignee cannot cancel", async () => {
    const { a, b, alice, bob, handoff_id } = await open();
    for (const [who, tool, args] of [
      [alice, "complete_handoff", { result: "x" }],
      [alice, "fail_handoff", { reason: "x" }],
      [bob, "cancel_handoff", { reason: "x" }],
    ] as const) {
      const r = await who.call(tool, { handoff_id, ...args });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(who === alice ? "assignee" : "requester");
    }
    await Bun.sleep(200);
    expect(host.messagesOf(a)).toEqual([]);
    expect(host.messagesOf(b)).toHaveLength(1);
  });
});

describe("final handoffs", () => {
  for (const end of ["complete_handoff", "fail_handoff", "cancel_handoff"] as const) {
    test(`after ${end} every further action is refused and delivers nothing`, async () => {
      const { a, b, alice, bob, handoff_id } = await open();
      const closer = end === "cancel_handoff" ? alice : bob;
      const args = end === "complete_handoff" ? { result: "r" } : { reason: "r" };
      expect((await closer.call(end, { handoff_id, ...args })).isError).toBe(false);
      await host.until(
        () =>
          host.messagesOf(end === "cancel_handoff" ? b : a).length ===
          (end === "cancel_handoff" ? 2 : 1),
      );
      const before = [host.messagesOf(a).length, host.messagesOf(b).length];

      for (const [who, tool, extra] of [
        [bob, "complete_handoff", { result: "again" }],
        [bob, "fail_handoff", { reason: "again" }],
        [alice, "cancel_handoff", { reason: "again" }],
      ] as const) {
        const r = await who.call(tool, { handoff_id, ...extra });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("already");
      }
      await Bun.sleep(200);
      expect([host.messagesOf(a).length, host.messagesOf(b).length]).toEqual(before);
    });
  }
});
