import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startHandoffHost, parse, type BotCaller, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

const BRIEF = "Goal: do it. Context: none. Constraints: none. Deliverable: text. Done when: done.";

type Bot = { call: BotCaller };

async function bots(n: number) {
  const ids = Array.from({ length: n }, (_, i) => host.createBot(`Bot${i}`, `bot ${i}`));
  const callers: Bot[] = [];
  for (const id of ids) callers.push(await host.actAs(id));
  return { ids, as: callers };
}

const handOff = (who: Bot, to: string, extra: Record<string, unknown> = {}) =>
  who.call("hand_off", { to, title: "t", brief: BRIEF, ...extra });

describe("hand_off guardrails", () => {
  test("refuses a cycle of two and of three, and allows the edge once the loop's handoff finishes", async () => {
    const {
      ids: [a, b, c],
      as: [alice, bob, cy],
    } = await bots(3);
    const ab = parse<{ handoff_id: string }>(await handOff(alice, b)).handoff_id;
    const back = await handOff(bob, a);
    expect(back.isError).toBe(true);
    expect(back.text).toContain("loop");

    expect((await handOff(bob, c)).isError).toBe(false);
    expect((await handOff(cy, a)).text).toContain("loop");

    await bob.call("complete_handoff", { handoff_id: ab, result: "ok" });
    expect((await handOff(bob, a)).isError).toBe(false);
  });

  test("allows a chain of three and refuses a fourth link for depth", async () => {
    const {
      ids: [, b, c, d, e],
      as: [alice, bob, cy, dan],
    } = await bots(5);
    expect((await handOff(alice, b)).isError).toBe(false);
    expect((await handOff(bob, c)).isError).toBe(false);
    expect((await handOff(cy, d)).isError).toBe(false);
    const r = await handOff(dan, e);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("chain");
  });

  test("refuses a link that would join two chains too deep, even though neither is too deep alone", async () => {
    const {
      ids: [, b, c, d, e],
      as: [alice, , cy, dan],
    } = await bots(5);
    await handOff(alice, b);
    await handOff(cy, d);
    const r = await handOff(dan, e);
    expect(r.isError).toBe(false);
    expect((await handOff(await host.actAs(b), c)).text).toContain("chain");
  });

  test("refuses a sixth open handoff from one requester until one finishes", async () => {
    const {
      ids,
      as: [alice, ...others],
    } = await bots(7);
    const first = parse<{ handoff_id: string }>(await handOff(alice, ids[1]!)).handoff_id;
    for (const to of ids.slice(2, 6)) expect((await handOff(alice, to)).isError).toBe(false);
    const sixth = await handOff(alice, ids[6]!);
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain("5 open");

    await others[0]!.call("complete_handoff", { handoff_id: first, result: "ok" });
    expect((await handOff(alice, ids[6]!)).isError).toBe(false);
  });

  test("refuses self, unknown bot, empty brief and over-long title, creating nothing", async () => {
    const {
      ids: [a, b],
      as: [alice],
    } = await bots(2);
    expect((await handOff(alice, a)).isError).toBe(true);
    expect((await handOff(alice, "no-such-bot")).isError).toBe(true);
    expect((await handOff(alice, b, { brief: "   " })).isError).toBe(true);
    const long = await handOff(alice, b, { title: "x".repeat(81) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("80");
    expect((await handOff(alice, b, { title: "x".repeat(80) })).isError).toBe(false);
    await host.until(() => host.messagesOf(b).length >= 1);
    expect(host.messagesOf(b)).toHaveLength(1);
  });
});
