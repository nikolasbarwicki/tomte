import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { defined } from "../testing/defined.ts";
import { startHandoffHost, parse, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

const BRIEF =
  "Goal: find the cheapest flight. Context: none. Constraints: none. Deliverable: a price. Done when: you have it.";

async function pair() {
  const a = host.createBot("Alice", "plans trips");
  const b = host.createBot("Bob", "searches flights");
  return { a, b, alice: await host.actAs(a), bob: await host.actAs(b) };
}

describe("list_bots", () => {
  test("lists every other bot with id, name, purpose and status, never the caller", async () => {
    const { a, b, alice } = await pair();
    const c = host.createBot("Cy", "writes");
    const bots = parse<{ id: string; name: string; description: string; status: string }[]>(
      await alice.call("list_bots"),
    );
    expect(bots.map((x) => x.id).sort()).toEqual([b, c].sort());
    expect(bots.find((x) => x.id === b)).toEqual({
      id: b,
      name: "Bob",
      description: "searches flights",
      status: "idle",
    });
    expect(bots.some((x) => x.id === a)).toBe(false);
  });

  test("shows a bot in a running turn as working", async () => {
    const { a, b, bob } = await pair();
    host.hold();
    await bob.call("hand_off", { to: a, title: "t", brief: BRIEF });
    await host.until(() => host.messagesOf(a).length === 1);
    const alice = await host.actAs(b);
    const bots = parse<{ id: string; status: string }[]>(await alice.call("list_bots"));
    expect(bots.find((x) => x.id === a)?.status).toBe("working");
  });
});

describe("hand off and complete", () => {
  test("hand_off answers at once and the brief reaches an assignee that is not open in the UI", async () => {
    const { a, b, alice } = await pair();
    const r = await alice.call("hand_off", { to: b, title: "Flights", brief: BRIEF });
    expect(r.isError).toBe(false);
    const { handoff_id, status } = parse<{ handoff_id: string; status: string }>(r);
    expect(status).toBe("submitted");
    expect(host.server.currentBotId()).toBeUndefined();

    await host.until(() => host.messagesOf(b).length === 1);
    const [msg] = host.messagesOf(b);
    expect(msg).toContain(`<handoff id="${handoff_id}" requester="Alice" title="Flights">`);
    expect(msg).toContain(BRIEF);
    expect(msg).toContain("complete_handoff");
    expect(host.messagesOf(a)).toEqual([]);
  });

  test("a brief for a busy assignee arrives once its turn ends", async () => {
    const { b, alice } = await pair();
    const c = host.createBot("Cy", "writes");
    const cy = await host.actAs(c);
    host.hold();
    await cy.call("hand_off", { to: b, title: "First", brief: BRIEF });
    await host.until(() => host.messagesOf(b).length === 1);

    await alice.call("hand_off", { to: b, title: "Second", brief: BRIEF });
    await Bun.sleep(300);
    expect(host.messagesOf(b)).toHaveLength(1);

    host.release();
    await host.until(() => host.messagesOf(b).length === 2);
    expect(host.messagesOf(b)[1]).toContain('title="Second"');
  });

  test("complete_handoff delivers the result to the requester", async () => {
    const { a, b, alice, bob } = await pair();
    const { handoff_id } = parse<{ handoff_id: string }>(
      await alice.call("hand_off", { to: b, title: "Flights", brief: BRIEF }),
    );
    await host.until(() => host.messagesOf(b).length === 1);

    const done = await bob.call("complete_handoff", { handoff_id, result: "EUR 120 via Lisbon" });
    expect(parse(done)).toEqual({ handoff_id, status: "completed" });
    await host.until(() => host.messagesOf(a).length === 1);
    const msg = host.messagesOf(a)[0];
    expect(msg).toContain(`<handoff-update id="${handoff_id}" from="Bob" status="completed">`);
    expect(msg).toContain("EUR 120 via Lisbon");
  });

  test("hand_off to an unknown bot is refused and nothing is delivered", async () => {
    const { alice } = await pair();
    const r = await alice.call("hand_off", {
      to: "00000000-0000-4000-8000-000000000000",
      title: "t",
      brief: BRIEF,
    });
    expect(r.isError).toBe(true);
  });
});

describe("endpoint hardening", () => {
  const post = (url: string, headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const handOff = (to: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "hand_off", arguments: { to, title: "t", brief: BRIEF } },
    });

  test("refuses no token, a wrong token, a revoked token, an Origin header and a wrong Host", async () => {
    const { b, alice } = await pair();
    const auth = { authorization: `Bearer ${alice.token}` };
    expect((await post(alice.url, auth)).status).toBe(200);
    expect((await post(alice.url, {})).status).toBe(401);
    expect((await post(alice.url, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(alice.url, { ...auth, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(alice.url, { ...auth, host: "evil.example" })).status).toBe(403);

    alice.revoke();
    expect((await post(alice.url, auth)).status).toBe(401);
    const refused = await fetch(alice.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${alice.token}`,
      },
      body: handOff(b),
    });
    expect(refused.status).toBe(401);
    await Bun.sleep(200);
    expect(host.messagesOf(b)).toEqual([]);
  });
});

describe("bot sessions", () => {
  test("a session gets the bots instructions and the browser, bots and routines servers, and every token works", async () => {
    const a = host.createBot("Alice", "plans trips");
    host.createBot("Bob", "searches flights");
    expect((await host.ui("/api/bots/browser", { botId: a, enabled: true })).status).toBe(200);
    expect((await host.ui("/api/open", { botId: a })).status).toBe(200);
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.launches().length === 1);

    const launch = defined(host.launches()[0], "launch");
    expect(launch.appendSystemPrompt).toContain("## Other bots");
    expect(launch.appendSystemPrompt).toContain(
      "goal, context, constraints, deliverable, and done when",
    );
    expect(launch.appendSystemPrompt).toContain("## Browser");
    expect(launch.appendSystemPrompt).toContain("## Routines");
    expect(Object.keys(launch.mcpServers).sort()).toEqual(["bots", "browser", "routines"]);

    for (const [name, tool, args] of [
      ["bots", "list_bots", {}],
      ["browser", "browser_open", { url: "https://example.com" }],
      ["routines", "list_routines", {}],
    ] as const) {
      const s = defined(launch.mcpServers[name], name);
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } }),
      );
      expect((await client.callTool({ name: tool, arguments: args })).isError).toBeFalsy();
      await client.close();
    }
  });
});
