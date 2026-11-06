import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startHandoffHost, parse, type HandoffHost } from "./test-host.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

type Row = { handoff_id: string; status: string; title: string; other_bot: { name: string }; last_message: { text: string } };

async function open() {
  const a = host.createBot("Alice", "plans");
  const b = host.createBot("Bob", "flights");
  const alice = await host.actAs(a);
  const bob = await host.actAs(b);
  const { handoff_id } = parse<{ handoff_id: string }>(await alice.call("hand_off", { to: b, title: "Flights", brief: "brief" }));
  await host.until(() => host.messagesOf(b).length === 1);
  return { a, b, alice, bob, id: handoff_id };
}

describe("conversation", () => {
  test("list_handoffs shows working for both parties once the brief turn started", async () => {
    const { alice, bob, id } = await open();
    for (const p of [alice, bob]) {
      const [row] = parse<Row[]>(await p.call("list_handoffs"));
      expect(row).toMatchObject({ handoff_id: id, status: "working", title: "Flights", last_message: { text: "brief" } });
    }
  });

  test("assignee message sets input-required, requester reply sets working, each reaching the other session", async () => {
    const { a, b, alice, bob, id } = await open();
    expect(parse(await bob.call("handoff_message", { handoff_id: id, text: "which dates?" }))).toEqual({ handoff_id: id, status: "input-required" });
    await host.until(() => host.messagesOf(a).length === 1);
    expect(host.messagesOf(a)[0]).toContain("which dates?");
    expect(parse<Row[]>(await alice.call("list_handoffs"))[0]).toMatchObject({ status: "input-required", last_message: { text: "which dates?" } });

    expect(parse(await alice.call("handoff_message", { handoff_id: id, text: "May 3" }))).toEqual({ handoff_id: id, status: "working" });
    await host.until(() => host.messagesOf(b).length === 2);
    expect(host.messagesOf(b)[1]).toContain("May 3");
    expect(parse<Row[]>(await bob.call("list_handoffs"))[0].status).toBe("working");
  });

  test("list_handoffs hides other bots' and finished handoffs; non-parties cannot message", async () => {
    const { b, bob, id } = await open();
    const c = host.createBot("Cy", "writes");
    const cy = await host.actAs(c);
    expect(parse<Row[]>(await cy.call("list_handoffs"))).toEqual([]);
    const r = await cy.call("handoff_message", { handoff_id: id, text: "hi" });
    expect(r.isError).toBe(true);
    await Bun.sleep(150);
    expect(host.messagesOf(b)).toHaveLength(1);

    await bob.call("complete_handoff", { handoff_id: id, result: "done" });
    expect(parse<Row[]>(await bob.call("list_handoffs"))).toEqual([]);
  });
});
