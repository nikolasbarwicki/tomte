import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// Gate step 4 ("brief me every weekday at 8" creates the routine), at the host HTTP seam: a chat message makes the fake CLI call the routine tools on the server entry of its own MCP config, as the real CLI does, so a pass proves the lease carries the routines server, its instructions and its token. Only a live run with the real model proves the model chooses to call the tool.
import { writeFileSync } from "node:fs";

import { readMemory, userMemoryPath } from "../bots/index.ts";
import {
  routinesOf as panelList,
  UNATTENDED,
  WEEKDAYS,
  type RoutineOut,
  type ToolOut,
} from "../testing/routines-kit.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";
import { ROUTINES_INSTRUCTIONS, ROUTINES_SERVER_NAME } from "./index.ts";

let host: HandoffHost;
beforeEach(async () => {
  host = await startHandoffHost();
  writeFileSync(userMemoryPath(host.dataRoot), "Time zone: Europe/Warsaw\n");
});
afterEach(async () => host.stop());

const toolOut = (text: string) => parse<ToolOut>({ isError: false, text });
const routinesOf = (botId: string) => panelList(host, botId);
const call = (tool: string, args: Record<string, unknown>) =>
  host.callOnMessage(ROUTINES_SERVER_NAME, tool, args);

/** The owner's time zone, as the bot reads it from user memory. */
const ownerZone = () => /Time zone: (\S+)/.exec(readMemory(userMemoryPath(host.dataRoot)))?.[1];

/** The bot's chat is open and the owner sends one message; resolves with what the scripted call got back once the turn is over. */
async function turn(botId: string, text: string) {
  const seen = host.toolResults().length;
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => host.toolResults().length === seen + 1);
  await host.until(() => !host.server.isWorking(botId));
  return host.toolResults()[seen]!;
}

async function openBot(name = "Ada") {
  const id = host.createBot(name);
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

const brief = (tz = ownerZone()) => ({
  name: "Weekday brief",
  instruction: "Summarize my calendar and inbox in at most 5 lines.",
  schedule: { ...WEEKDAYS, tz },
});

describe("a chat message that asks for a recurring job", () => {
  test("makes the CLI create the routine on its own routines server, and the panel list and the stream show it", async () => {
    const id = await openBot();
    const page = await watchEvents(host);
    call("create_routine", brief());
    const text = await turn(id, "brief me every weekday at 8");

    const { routine } = toolOut(text);
    expect(routine).toMatchObject({
      name: "Weekday brief",
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" },
      active: true,
    });
    expect(routine.next_runs).toHaveLength(3);

    expect(await routinesOf(id)).toMatchObject([
      {
        id: routine.id,
        name: "Weekday brief",
        schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" },
        active: true,
      },
    ]);
    await host.until(() => page.routines(id)?.some((r) => r.id === routine.id) === true);
    expect(page.routines(id)?.[0]).toMatchObject({ active: true, schedule: WEEKDAYS });

    const launch = host.launches()[0]!;
    expect(Object.keys(launch.mcpServers)).toContain(ROUTINES_SERVER_NAME);
    expect(launch.appendSystemPrompt).toContain(ROUTINES_INSTRUCTIONS);
    expect(launch.appendSystemPrompt).toContain("Time zone: Europe/Warsaw");
    expect(host.loopCalls().at(-1)).toMatchObject({
      server: ROUTINES_SERVER_NAME,
      tool: "create_routine",
    });
    page.stop();
  });

  test("pause and resume from chat show in the panel's list and on the stream", async () => {
    const id = await openBot();
    const page = await watchEvents(host);
    call("create_routine", brief());
    const { routine } = toolOut(await turn(id, "brief me every weekday at 8"));

    call("update_routine", { routine_id: routine.id, active: false });
    const paused = toolOut(await turn(id, "pause the weekday brief"));
    expect(paused.routine).toMatchObject({ id: routine.id, active: false, next_runs: [] });
    expect(await routinesOf(id)).toMatchObject([
      { id: routine.id, active: false, nextRunAt: null },
    ]);
    await host.until(() => page.routines(id)?.[0]?.active === false);

    call("update_routine", { routine_id: routine.id, active: true });
    const resumed = toolOut(await turn(id, "resume it"));
    expect(resumed.routine.active).toBe(true);
    expect((await routinesOf(id))[0]).toMatchObject({ active: true });
    expect((await routinesOf(id))[0]?.nextRunAt).not.toBeNull();
    await host.until(() => page.routines(id)?.[0]?.active === true);

    host.stopCalling();
    const calls = host.toolResults().length;
    expect((await host.ui("/api/send", { text: "thanks" })).status).toBe(200);
    await host.until(() => host.messagesOf(id).length === 4);
    await host.until(() => !host.server.isWorking(id));
    expect(host.toolResults()).toHaveLength(calls);
    page.stop();
  });

  test("a bad schedule gets the route's error text back and creates nothing; the corrected call goes through", async () => {
    const id = await openBot();
    call("create_routine", {
      ...brief(),
      schedule: { kind: "cron", expr: "every weekday", tz: "Europe/Warsaw" },
    });
    const refused = await turn(id, "brief me every weekday at 8");
    expect(refused).toStartWith("schedule: ");
    expect(host.loopCalls().at(-1)?.result?.isError).toBe(true);
    expect(await routinesOf(id)).toEqual([]);

    call("create_routine", {
      ...brief(),
      schedule: { kind: "cron", expr: "*/2 * * * *", tz: "Europe/Warsaw" },
    });
    expect(await turn(id, "again")).toContain("minimum interval is 5 minutes");
    expect(await routinesOf(id)).toEqual([]);

    call("create_routine", brief());
    const { routine } = toolOut(await turn(id, "once more"));
    expect((await routinesOf(id)).map((r) => r.id)).toEqual([routine.id]);
  });
});

describe("one bot's CLI and another bot's routine", () => {
  test("cannot list it or change it through its own routines server", async () => {
    const ada = await openBot("Ada");
    call("create_routine", brief());
    const { routine } = toolOut(await turn(ada, "brief me"));

    const grace = await openBot("Grace");
    call("list_routines", {});
    const listed = parse<{ routines: RoutineOut[] }>({
      isError: false,
      text: await turn(grace, "what do you run?"),
    });
    expect(listed.routines).toEqual([]);

    call("update_routine", { routine_id: routine.id, active: false });
    expect(await turn(grace, "pause it")).toBe("no such routine");
    expect(host.loopCalls().at(-1)?.result?.isError).toBe(true);
    expect(await routinesOf(grace)).toEqual([]);
    expect(await routinesOf(ada)).toMatchObject([{ id: routine.id, active: true }]);
  });
});

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("a %s routine turn", (_label, openChat) => {
  test("the CLI's create_routine call is refused with the unattended text and creates nothing", async () => {
    const id = host.createBot("Ada");
    const routineRes = await host.ui("/api/routines/create", { botId: id, ...brief() });
    expect(routineRes.status).toBe(200);
    const routineId = ((await routineRes.json()) as { id: string }).id;
    if (openChat) expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);

    call("create_routine", { ...brief(), name: "Planted" });
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await host.until(() => host.toolResults().length === 1);
    await host.until(() => !host.server.isWorking(id));

    expect(host.toolResults()).toEqual([UNATTENDED]);
    expect(host.loopCalls()[0]?.result?.isError).toBe(true);
    expect((await routinesOf(id)).map((r) => r.name)).toEqual(["Weekday brief"]);
  });
});
