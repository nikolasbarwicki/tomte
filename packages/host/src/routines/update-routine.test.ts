import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import {
  routinesOf as panelList,
  UNATTENDED,
  WEEKDAYS,
  type ToolOut,
} from "../testing/routines-kit.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost;
beforeEach(async () => void (host = await startHandoffHost()));
afterEach(async () => host.stop());

type Updated = ToolOut;

const routinesOf = (botId: string) => panelList(host, botId);

/** A routine made in the panel, so the tool under test is the only thing that changes it. */
async function create(botId: string, body: Record<string, unknown> = {}) {
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

async function bot(name = "Ada") {
  const id = host.createBot(name);
  return { id, call: (await host.actAs(id, "routines")).call };
}

describe("update_routine", () => {
  test("active false pauses: the panel's list shows no next run and next_runs is empty; active true resumes", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    expect((await routinesOf(id))[0]?.nextRunAt).not.toBeNull();

    const paused = parse<Updated>(
      await call("update_routine", { routine_id: routineId, active: false }),
    );
    expect(paused.routine).toMatchObject({ id: routineId, active: false, next_runs: [] });
    expect((await routinesOf(id))[0]).toMatchObject({ active: false, nextRunAt: null });

    const resumed = parse<Updated>(
      await call("update_routine", { routine_id: routineId, active: true }),
    );
    expect(resumed.routine.active).toBe(true);
    expect(resumed.routine.next_runs).toHaveLength(3);
    const [listed] = await routinesOf(id);
    expect(listed?.active).toBe(true);
    expect(listed?.nextRunAt).not.toBeNull();
  });

  test("changing only the schedule keeps name, instruction and flags; the result shows the new next_runs", async () => {
    const { id, call } = await bot();
    const routineId = await create(id, { catchUp: false });
    const schedule = { kind: "cron", expr: "30 7 * * *", tz: "America/New_York" };
    const { routine } = parse<Updated>(
      await call("update_routine", { routine_id: routineId, schedule }),
    );
    expect(routine).toMatchObject({
      name: "Brief",
      instruction: "Summarize my inbox",
      schedule,
      active: true,
      catch_up: false,
    });
    expect(routine.next_runs).toHaveLength(3);
    expect((await routinesOf(id))[0]).toMatchObject({ schedule, name: "Brief" });
  });

  test("changing only the name keeps the schedule and the instruction", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    const before = (await routinesOf(id))[0];
    const { routine } = parse<Updated>(
      await call("update_routine", { routine_id: routineId, name: "Morning brief" }),
    );
    expect(routine).toMatchObject({
      name: "Morning brief",
      instruction: "Summarize my inbox",
      schedule: WEEKDAYS,
    });
    expect((await routinesOf(id))[0]).toMatchObject({
      name: "Morning brief",
      instruction: before?.instruction,
      schedule: before?.schedule,
    });
  });

  test("instruction and catch_up change alone; a one-time schedule is set from an ISO instant", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { routine } = parse<Updated>(
      await call("update_routine", {
        routine_id: routineId,
        instruction: "Only the headlines",
        catch_up: false,
        schedule: { kind: "once", at },
      }),
    );
    expect(routine).toMatchObject({
      name: "Brief",
      instruction: "Only the headlines",
      catch_up: false,
      schedule: { kind: "once", at },
      next_runs: [at],
    });
    expect((await routinesOf(id))[0]).toMatchObject({
      instruction: "Only the headlines",
      catchUp: false,
    });
  });

  test.each([
    ["a bad cron", { kind: "cron", expr: "not a cron", tz: "UTC" }, ""],
    ["an unknown time zone", { kind: "cron", expr: "0 8 * * *", tz: "Mars/Olympus" }, ""],
    ["a once in the past", { kind: "once", at: "2001-01-01T00:00:00Z" }, "time is in the past"],
    [
      "an interval under 5 minutes",
      { kind: "cron", expr: "*/2 * * * *", tz: "UTC" },
      "minimum interval is 5 minutes",
    ],
  ])("%s returns the route's message and changes nothing", async (_n, schedule, message) => {
    const { id, call } = await bot();
    const routineId = await create(id);
    const before = await routinesOf(id);
    const r = await call("update_routine", { routine_id: routineId, name: "Renamed", schedule });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("schedule: ");
    expect(r.text).toContain(message);
    expect(await routinesOf(id)).toEqual(before);
  });

  test.each([
    ["a name over 80 characters", { name: "n".repeat(81) }],
    ["a blank name", { name: "   " }],
    ["an instruction over 8 KiB", { instruction: "i".repeat(8 * 1024 + 1) }],
    ["a blank instruction", { instruction: " " }],
  ])("%s is refused and changes nothing", async (_n, patch) => {
    const { id, call } = await bot();
    const routineId = await create(id);
    const before = await routinesOf(id);
    const r = await call("update_routine", { routine_id: routineId, ...patch });
    expect(r.isError).toBe(true);
    expect(await routinesOf(id)).toEqual(before);
  });

  test("a call with only routine_id answers 'nothing to change'", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    const before = await routinesOf(id);
    const r = await call("update_routine", { routine_id: routineId });
    expect(r).toEqual({ isError: true, text: "nothing to change" });
    expect(await routinesOf(id)).toEqual(before);
  });

  test("with the bot open, each update reaches the event stream as a routines event", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    const page = await watchEvents(host);
    const panel = () => page.routines(id)?.map((r) => [r.name, r.active]);
    await host.until(() => panel() !== undefined);
    expect(panel()).toEqual([["Brief", true]]);

    expect((await call("update_routine", { routine_id: routineId, name: "Renamed" })).isError).toBe(
      false,
    );
    await host.until(() => panel()?.[0]?.[0] === "Renamed");
    expect(panel()).toEqual([["Renamed", true]]);
    expect((await call("update_routine", { routine_id: routineId, active: false })).isError).toBe(
      false,
    );
    await host.until(() => panel()?.[0]?.[1] === false);
    page.stop();
  });

  test("a bot cannot update another bot's routine, and an unknown id answers the same", async () => {
    const ada = await bot("Ada");
    const grace = await bot("Grace");
    const graces = await create(grace.id);
    const before = await routinesOf(grace.id);

    const foreign = await ada.call("update_routine", {
      routine_id: graces,
      name: "Hijacked",
      active: false,
    });
    const unknown = await ada.call("update_routine", {
      routine_id: crypto.randomUUID(),
      name: "Hijacked",
    });
    expect(foreign).toEqual({ isError: true, text: "no such routine" });
    expect(unknown).toEqual(foreign);
    expect(await routinesOf(grace.id)).toEqual(before);
    expect(await routinesOf(ada.id)).toEqual([]);
  });

  test("the unknown-id answer comes before 'nothing to change', so it reveals nothing either", async () => {
    const ada = await bot("Ada");
    const grace = await bot("Grace");
    const graces = await create(grace.id);
    expect(await ada.call("update_routine", { routine_id: graces })).toEqual({
      isError: true,
      text: "no such routine",
    });
  });

  test("the endpoint serves exactly list_routines, create_routine and update_routine", async () => {
    const { id } = await bot();
    const caller = await host.actAs(id, "routines");
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
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "create_routine",
      "list_routines",
      "update_routine",
    ]);
    const update = defined(
      result.tools.find((t) => t.name === "update_routine"),
      "update_routine",
    );
    expect(Object.keys(update.inputSchema.properties).sort()).toEqual([
      "active",
      "catch_up",
      "instruction",
      "name",
      "routine_id",
      "schedule",
    ]);
  });
});

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine turn", (_label, openChat) => {
  test("update_routine is refused while the bot runs a routine, so a routine cannot pause itself; it works again afterwards", async () => {
    const { id, call } = await bot();
    const routineId = await create(id);
    if (openChat) expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    host.hold();
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 1);

    const refused = await call("update_routine", { routine_id: routineId, active: false });
    expect(refused).toEqual({ isError: true, text: UNATTENDED });
    expect((await routinesOf(id))[0]).toMatchObject({ name: "Brief", active: true });

    host.release();
    await host.until(() => !host.server.isWorking(id));
    let again = await call("update_routine", { routine_id: routineId, active: false });
    for (let i = 0; i < 100 && again.isError; i++) {
      await Bun.sleep(25);
      again = await call("update_routine", { routine_id: routineId, active: false });
    }
    expect(again.isError).toBe(false);
    expect((await routinesOf(id))[0]?.active).toBe(false);
  });
});

describe("a double-loop bot", () => {
  test("its front updates a routine while a routine run of the bot is in progress; the run's own session is refused", async () => {
    const id = host.createBot("Dev");
    setChatMode(host.dataRoot, id, "double_loop");
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 1);
    await host.until(() => !host.server.isWorking(id));
    const front = await host.asLaunched(0, "routines");

    const routineId = await create(id);
    host.hold();
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await host.until(() => host.launches().length === 2);
    const run = await host.asLaunched(1, "routines");
    await host.until(() => {
      const session = host.launches()[1]?.argv.find((a) => a.startsWith("--session-id="));
      return session !== undefined && host.messagesOf(session.slice(13)).length === 1;
    });

    expect(await run("update_routine", { routine_id: routineId, active: false })).toEqual({
      isError: true,
      text: UNATTENDED,
    });
    expect((await routinesOf(id))[0]?.active).toBe(true);
    const paused = await front("update_routine", { routine_id: routineId, active: false });
    expect(paused.isError).toBe(false);
    expect((await routinesOf(id))[0]?.active).toBe(false);

    host.release();
    await host.until(() => !host.server.isWorking(id));
  });
});
