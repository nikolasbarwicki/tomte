import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defined } from "../testing/defined.ts";
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
  return {
    id: (i: number) => defined(ids[i], `bot ${i} id`),
    as: (i: number) => defined(callers[i], `bot ${i}`),
  };
}

const handOff = (who: Bot, to: string, extra: Record<string, unknown> = {}) =>
  who.call("hand_off", { to, title: "t", brief: BRIEF, ...extra });

describe("hand_off guardrails", () => {
  test("refuses a cycle of two and of three, and allows the edge once the loop's handoff finishes", async () => {
    const { id, as } = await bots(3);
    const [a, b, c] = [id(0), id(1), id(2)];
    const [alice, bob, cy] = [as(0), as(1), as(2)];
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
    const { id, as } = await bots(5);
    const [b, c, d, e] = [id(1), id(2), id(3), id(4)];
    const [alice, bob, cy, dan] = [as(0), as(1), as(2), as(3)];
    expect((await handOff(alice, b)).isError).toBe(false);
    expect((await handOff(bob, c)).isError).toBe(false);
    expect((await handOff(cy, d)).isError).toBe(false);
    const r = await handOff(dan, e);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("chain");
  });

  test("refuses a link that would join two chains too deep, even though neither is too deep alone", async () => {
    const { id, as } = await bots(5);
    const [b, c, d, e] = [id(1), id(2), id(3), id(4)];
    const [alice, cy, dan] = [as(0), as(2), as(3)];
    await handOff(alice, b);
    await handOff(cy, d);
    const r = await handOff(dan, e);
    expect(r.isError).toBe(false);
    expect((await handOff(await host.actAs(b), c)).text).toContain("chain");
  });

  test("refuses a sixth open handoff from one requester until one finishes", async () => {
    const { id, as } = await bots(7);
    const alice = as(0);
    const first = parse<{ handoff_id: string }>(await handOff(alice, id(1))).handoff_id;
    for (const i of [2, 3, 4, 5]) expect((await handOff(alice, id(i))).isError).toBe(false);
    const sixth = await handOff(alice, id(6));
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain("5 open");

    await as(1).call("complete_handoff", { handoff_id: first, result: "ok" });
    expect((await handOff(alice, id(6))).isError).toBe(false);
  });

  test("refuses self, unknown bot, empty brief and over-long title, creating nothing", async () => {
    const { id, as } = await bots(2);
    const [a, b] = [id(0), id(1)];
    const alice = as(0);
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
