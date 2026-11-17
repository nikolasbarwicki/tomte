import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import {
  routinesOf as panelList,
  UNATTENDED,
  WEEKDAYS,
  type ToolOut,
} from "../testing/routines-kit.ts";
import { parse, startHandoffHost, type BotCaller, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(async () => host.stop());

type Created = ToolOut;

const base = { name: "Brief", instruction: "Summarize my inbox", schedule: WEEKDAYS };

const routinesOf = (botId: string) => panelList(host, botId);

async function bot(name = "Ada") {
  const id = host.createBot(name);
  return { id, call: (await host.actAs(id, "routines")).call };
}

describe("create_routine", () => {
  test("a cron routine is created active with catch-up on, and the panel's list returns it", async () => {
    const { id, call } = await bot();
    const before = Date.now();
    const r = await call("create_routine", base);
    expect(r.isError).toBe(false);
    const { now, routine } = parse<Created>(r);
    expect(Date.parse(now)).toBeGreaterThanOrEqual(before);
    expect(routine).toMatchObject({
      name: "Brief",
      instruction: "Summarize my inbox",
      schedule: WEEKDAYS,
      active: true,
      catch_up: true,
    });
    expect(routine.next_runs).toHaveLength(3);

    const listed = await routinesOf(id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: routine.id, name: "Brief", active: true, catchUp: true });
  });

  test("catch_up and active are taken as given", async () => {
    const { id, call } = await bot();
    const { routine } = parse<Created>(
      await call("create_routine", { ...base, catch_up: false, active: false }),
    );
    expect(routine).toMatchObject({ active: false, catch_up: false, next_runs: [] });
    expect((await routinesOf(id))[0]).toMatchObject({ active: false, catchUp: false });
  });

  test("with the bot open, the event stream carries the new routine without any UI call", async () => {
    const { id, call } = await bot();
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    const ctl = new AbortController();
    const res = await fetch(`${host.clientUrl}/api/events`, {
      signal: ctl.signal,
      headers: host.authHeaders,
    });
    let seen = "";
    void (async () => {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        seen += new TextDecoder().decode(value);
      }
    })().catch(() => undefined);
    const carries = () =>
      seen
        .split("\n\n")
        .filter((l) => l.startsWith("data: "))
        .flatMap((l) => eventsOf(l.slice(6)) as { type: string; routines?: { name: string }[] }[])
        .some((e) => e.type === "routines" && e.routines?.some((r) => r.name === "Pushed"));
    await Bun.sleep(100);
    expect(carries()).toBe(false);

    expect((await call("create_routine", { ...base, name: "Pushed" })).isError).toBe(false);
    await host.until(carries);
    ctl.abort();
  });

  test("a one-time routine in the future is created and fires once at that instant", async () => {
    const { call } = await bot();
    const at = new Date(Date.now() + 2 * 3_600_000);
    const { routine } = parse<Created>(
      await call("create_routine", { ...base, schedule: { kind: "once", at: at.toISOString() } }),
    );
    expect(routine.schedule).toEqual({ kind: "once", at: at.toISOString() });
    expect(routine.next_runs).toEqual([at.toISOString()]);
  });

  test("an offset in `at` is honoured", async () => {
    const { call } = await bot();
    const at = new Date(Date.now() + 2 * 3_600_000);
    const withOffset = at.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const { routine } = parse<Created>(
      await call("create_routine", { ...base, schedule: { kind: "once", at: withOffset } }),
    );
    expect(routine.schedule.at).toBe(new Date(Date.parse(withOffset)).toISOString());
  });

  test("an `at` without an offset is refused and nothing is created", async () => {
    const { id, call } = await bot();
    const r = await call("create_routine", {
      ...base,
      schedule: { kind: "once", at: "2099-01-01T08:00:00" },
    });
    expect(r.isError).toBe(true);
    expect(await routinesOf(id)).toEqual([]);
  });

  test("an `at` in the past is refused with the route's message", async () => {
    const { id, call } = await bot();
    const r = await call("create_routine", {
      ...base,
      schedule: { kind: "once", at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("schedule: time is in the past");
    expect(await routinesOf(id)).toEqual([]);
  });

  test.each([
    ["a bad cron", { kind: "cron", expr: "not a cron", tz: "UTC" }, ""],
    ["an unknown time zone", { kind: "cron", expr: "0 8 * * *", tz: "Mars/Olympus" }, ""],
    ["a schedule that never fires", { kind: "cron", expr: "0 0 31 2 *", tz: "UTC" }, ""],
    [
      "a cron more often than every 5 minutes",
      { kind: "cron", expr: "*/2 * * * *", tz: "UTC" },
      "minimum interval is 5 minutes",
    ],
  ])(
    "%s returns an error result with the route's message and creates nothing",
    async (_n, schedule, message) => {
      const { id, call } = await bot();
      const r = await call("create_routine", { ...base, schedule });
      expect(r.isError).toBe(true);
      expect(r.text).toStartWith("schedule: ");
      expect(r.text).toContain(message);
      expect(await routinesOf(id)).toEqual([]);
    },
  );

  test.each([
    ["a name over 80 characters", { name: "n".repeat(81) }],
    ["an empty name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["an instruction over 8 KiB", { instruction: "i".repeat(8 * 1024 + 1) }],
    ["an instruction over 8 KiB in bytes", { instruction: "ł".repeat(4 * 1024 + 1) }],
    ["an empty instruction", { instruction: "" }],
  ])("%s returns an error result and creates nothing", async (_n, patch) => {
    const { id, call } = await bot();
    const r = await call("create_routine", { ...base, ...patch });
    expect(r.isError).toBe(true);
    expect(await routinesOf(id)).toEqual([]);
  });

  test("a name of 80 characters and an instruction of exactly 8 KiB are accepted", async () => {
    const { call } = await bot();
    const r = await call("create_routine", {
      ...base,
      name: "n".repeat(80),
      instruction: "i".repeat(8 * 1024),
    });
    expect(r.isError).toBe(false);
  });

  test("the 21st routine of a bot is refused with the cap named; another bot and the panel are not capped", async () => {
    const ada = await bot("Ada");
    const grace = await bot("Grace");
    for (let i = 0; i < 19; i++)
      expect((await host.ui("/api/routines/create", { botId: ada.id, ...base })).status).toBe(200);
    expect((await ada.call("create_routine", base)).isError).toBe(false);

    const refused = await ada.call("create_routine", base);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("20");
    expect(refused.text).toContain("Routines panel");
    expect(await routinesOf(ada.id)).toHaveLength(20);

    expect((await grace.call("create_routine", base)).isError).toBe(false);
    expect((await host.ui("/api/routines/create", { botId: ada.id, ...base })).status).toBe(200);
    expect(await routinesOf(ada.id)).toHaveLength(21);
  });

  test("a bot creates only for itself: the tool takes no bot id, policy or grant, and extra arguments change nothing", async () => {
    const ada = await bot("Ada");
    const grace = await bot("Grace");
    const { routine } = parse<Created>(
      await ada.call("create_routine", { ...base, botId: grace.id, tools: { Bash: "auto" } }),
    );
    expect(await routinesOf(grace.id)).toEqual([]);
    expect((await routinesOf(ada.id)).map((r) => r.id)).toEqual([routine.id]);
    expect(Object.keys(routine).sort()).not.toContain("tools");

    const caller = await host.actAs(ada.id, "routines");
    const res = await fetch(caller.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${caller.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = (await res.json()) as {
      result: { tools: { name: string; inputSchema: { properties: object } }[] };
    };
    const tool = defined(
      result.tools.find((t) => t.name === "create_routine"),
      "create_routine",
    );
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      "active",
      "catch_up",
      "instruction",
      "name",
      "schedule",
    ]);
  });
});

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine turn", (_label, openChat) => {
  test("create_routine is refused while the bot runs a routine and creates nothing; list_routines still answers", async () => {
    const { id, call } = await bot();
    const routineRes = await host.ui("/api/routines/create", { botId: id, ...base });
    const routineId = ((await routineRes.json()) as { id: string }).id;
    if (openChat) expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    host.hold();
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 1);

    const refused = await call("create_routine", { ...base, name: "Planted" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(UNATTENDED);
    expect((await routinesOf(id)).map((r) => r.name)).toEqual(["Brief"]);
    const listed = parse<{ routines: { name: string }[] }>(await call("list_routines"));
    expect(listed.routines.map((r) => r.name)).toEqual(["Brief"]);

    host.release();
    await host.until(() => !host.server.isWorking(id));
    const again = await callWhenIdle(call);
    expect(again.isError).toBe(false);
  });
});

/** The refusal ends with the run: retries until the run's bookkeeping has cleared. */
async function callWhenIdle(call: BotCaller) {
  let r = await call("create_routine", { ...base, name: "After" });
  for (let i = 0; i < 100 && r.isError; i++) {
    await Bun.sleep(25);
    r = await call("create_routine", { ...base, name: "After" });
  }
  return r;
}

describe("a double-loop bot", () => {
  test("its front creates routines while a routine run of the bot is in progress; the run's own session is refused", async () => {
    const id = host.createBot("Dev");
    setChatMode(host.dataRoot, id, "double_loop");
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 1);
    await host.until(() => !host.server.isWorking(id));
    const front = await host.asLaunched(0, "routines");

    const routineRes = await host.ui("/api/routines/create", { botId: id, ...base });
    const routineId = ((await routineRes.json()) as { id: string }).id;
    host.hold();
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await host.until(() => host.launches().length === 2);
    const run = await host.asLaunched(1, "routines");
    await host.until(() => {
      const session = host.launches()[1]?.argv.find((a) => a.startsWith("--session-id="));
      return session !== undefined && host.messagesOf(session.slice(13)).length === 1;
    });

    const refused = await run("create_routine", { ...base, name: "Planted" });
    expect(refused).toMatchObject({ isError: true, text: UNATTENDED });
    const created = await front("create_routine", { ...base, name: "From the front" });
    expect(created.isError).toBe(false);
    expect((await routinesOf(id)).map((r) => r.name).sort()).toEqual(["Brief", "From the front"]);

    host.release();
    await host.until(() => !host.server.isWorking(id));
  });
});
