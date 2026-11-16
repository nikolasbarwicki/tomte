import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { ROUTINES_ENDPOINT_PATH, ROUTINES_INSTRUCTIONS, ROUTINES_SERVER_NAME } from "./index.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(() => host.stop());

const WEEKDAYS = { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" };

type RoutineOut = {
  id: string;
  name: string;
  instruction: string;
  schedule: { kind: string; expr?: string; tz?: string; at?: string };
  active: boolean;
  catch_up: boolean;
  next_runs: string[];
  running: boolean;
  last_run: { status: string; started_at: string; error: string | null } | null;
};
type ListOut = { now: string; routines: RoutineOut[] };

async function create(botId: string, body: Record<string, unknown>) {
  const res = await host.ui("/api/routines/create", {
    botId,
    name: "Brief",
    instruction: "Summarize my inbox",
    schedule: WEEKDAYS,
    ...body,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

describe("list_routines", () => {
  test("a bot with no routines gets an empty list and the current time", async () => {
    const bot = host.createBot("Ada");
    const before = Date.now();
    const out = parse<ListOut>(await (await host.actAs(bot, "routines")).call("list_routines"));
    expect(out.routines).toEqual([]);
    expect(Date.parse(out.now)).toBeGreaterThanOrEqual(before);
    expect(out.now).toEndWith("Z");
  });

  test("lists the caller's routines in creation order and never another bot's", async () => {
    const ada = host.createBot("Ada");
    const grace = host.createBot("Grace");
    const first = await create(ada, { name: "First" });
    await Bun.sleep(5);
    const second = await create(ada, { name: "Second" });
    await create(grace, { name: "Grace's" });

    const { routines } = parse<ListOut>(
      await (await host.actAs(ada, "routines")).call("list_routines"),
    );
    expect(routines.map((r) => [r.id, r.name])).toEqual([
      [first, "First"],
      [second, "Second"],
    ]);
  });

  test("a cron routine shows its schedule as stored, three ISO UTC next runs, and no run yet", async () => {
    const bot = host.createBot("Ada");
    const id = await create(bot, { catchUp: false });
    const { routines } = parse<ListOut>(
      await (await host.actAs(bot, "routines")).call("list_routines"),
    );
    const [r] = routines;
    expect(r).toMatchObject({
      id,
      name: "Brief",
      instruction: "Summarize my inbox",
      schedule: WEEKDAYS,
      active: true,
      catch_up: false,
      running: false,
      last_run: null,
    });
    const next = defined(r, "routine").next_runs;
    expect(next).toHaveLength(3);
    for (const t of next) {
      expect(t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      // 08:00 in Warsaw is 06:00 or 07:00 UTC, and never a weekend.
      expect(["06:00", "07:00"]).toContain(t.slice(11, 16));
      expect([0, 6]).not.toContain(new Date(t).getUTCDay());
    }
    expect([...next].sort()).toEqual(next);
  });

  test("a one-time routine shows its instant as ISO UTC and a paused routine has no next runs", async () => {
    const bot = host.createBot("Ada");
    const at = Date.now() + 3_600_000;
    await create(bot, { name: "Once", schedule: { kind: "once", at } });
    await create(bot, { name: "Paused", active: false });

    const { routines } = parse<ListOut>(
      await (await host.actAs(bot, "routines")).call("list_routines"),
    );
    const once = defined(
      routines.find((r) => r.name === "Once"),
      "once",
    );
    expect(once.schedule).toEqual({ kind: "once", at: new Date(at).toISOString() });
    expect(once.next_runs).toEqual([new Date(at).toISOString()]);
    const paused = defined(
      routines.find((r) => r.name === "Paused"),
      "paused",
    );
    expect(paused).toMatchObject({ active: false, next_runs: [] });
  });

  test("the last run shows its status, start and error, and never its output", async () => {
    const bot = host.createBot("Ada");
    const id = await create(bot, {});
    await host.ui("/api/open", { botId: bot });
    expect((await host.ui("/api/routines/run", { id })).status).toBe(200);
    const caller = await host.actAs(bot, "routines");
    const read = async () => parse<ListOut>(await caller.call("list_routines")).routines[0];
    for (let i = 0; i < 200 && (await read())?.last_run?.status !== "succeeded"; i++)
      await Bun.sleep(25);
    await host.until(() => !host.server.isWorking(bot));

    const raw = await caller.call("list_routines");
    const [r] = parse<ListOut>(raw).routines;
    const last = defined(r, "routine").last_run;
    expect(last).toMatchObject({ status: "succeeded", error: null });
    expect(Date.parse(last?.started_at ?? "")).not.toBeNaN();
    expect(raw.text).not.toContain("output");
  });
});

describe("the routines endpoint", () => {
  test("is on the agent listener and refuses no token, a wrong token, an Origin header, a wrong Host and a revoked token", async () => {
    const bot = host.createBot("Ada");
    const ada = await host.actAs(bot, "routines");
    const auth = { authorization: `Bearer ${ada.token}` };
    expect(ada.url).toBe(`${host.agentUrl}${ROUTINES_ENDPOINT_PATH}`);
    expect((await post(ada.url, auth)).status).toBe(200);
    expect((await post(ada.url, {})).status).toBe(401);
    expect((await post(ada.url, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(ada.url, { ...auth, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(ada.url, { ...auth, host: "evil.example" })).status).toBe(403);

    ada.revoke();
    expect((await post(ada.url, auth)).status).toBe(401);
  });
});

describe("what a session is launched with", () => {
  const message = async (bot: string, text: string) => {
    expect((await host.ui("/api/open", { id: bot, botId: bot })).status).toBe(200);
    expect((await host.ui("/api/send", { text })).status).toBe(200);
    await host.until(() => host.messagesOf(bot).length === 1);
    await host.until(() => !host.server.isWorking(bot));
  };

  test("a standard bot's launch carries the routines server with its own token and its instructions in the system prompt", async () => {
    const bot = host.createBot("Ada");
    await message(bot, "hello");
    const launch = defined(host.launches()[0], "launch");
    const routines = defined(launch.mcpServers[ROUTINES_SERVER_NAME], "routines server");
    const bots = defined(launch.mcpServers.bots, "bots server");
    expect(routines.url).toBe(`${host.agentUrl}${ROUTINES_ENDPOINT_PATH}`);
    expect(routines.headers.Authorization).toStartWith("Bearer ");
    expect(routines.headers.Authorization).not.toBe(bots.headers.Authorization);
    expect(launch.appendSystemPrompt).toContain(ROUTINES_INSTRUCTIONS);

    const res = await post(routines.url, { authorization: routines.headers.Authorization });
    expect(res.status).toBe(200);
  });

  test("a double-loop bot's front gets the routines lease as it gets the bots lease", async () => {
    const bot = host.createBot("Dev");
    setChatMode(host.dataRoot, bot, "double_loop");
    await message(bot, "hello");
    const launch = defined(host.launches()[0], "launch");
    expect(Object.keys(launch.mcpServers)).toEqual(["bots", "routines"]);
    expect(launch.appendSystemPrompt).toContain(ROUTINES_INSTRUCTIONS);
  });
});

function post(url: string, headers: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}
