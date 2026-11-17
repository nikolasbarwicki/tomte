import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COLOR_NAMES, SHAPE_NAMES } from "@tomte/contract/avatars";

import { getBot } from "../bots/index.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const BRIEF =
  "Goal: find the cheapest flight. Context: none. Constraints: none. Deliverable: a price. Done when: you have it.";

let host: HandoffHost;
let scratch: string;
beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bot-delete-"));
  host = await startHandoffHost(["--data-root", join(scratch, "state")]);
});
afterEach(async () => {
  await host.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const rows = (query: string, botId: string) => {
  const db = new Database(join(host.dataRoot, "tomte.db"), { readonly: true });
  try {
    return db.query(query).all(botId);
  } finally {
    db.close();
  }
};
const routinesOf = (botId: string) => rows("SELECT 1 FROM routines WHERE bot_id = ?", botId);
const activityOf = (botId: string) => rows("SELECT 1 FROM bot_activity WHERE bot_id = ?", botId);

async function addRoutine(botId: string) {
  const res = await host.ui("/api/routines/create", {
    botId,
    name: "daily",
    instruction: "check the news",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  });
  expect(res.status).toBe(200);
}

test("deleting a bot removes its routines and activity, moves its directory to the trash and shows another bot", async () => {
  const keep = host.createBot("Keep", "stays");
  const gone = host.createBot("Gone", "leaves");
  expect((await host.ui("/api/open", { botId: gone })).status).toBe(200);
  await addRoutine(gone);
  await addRoutine(keep);
  expect((await host.ui("/api/seen", { botId: gone })).status).toBe(200);
  expect(activityOf(gone)).toHaveLength(1);

  expect((await host.ui("/api/bots/delete", { botId: gone })).status).toBe(200);

  expect(getBot(host.dataRoot, gone)).toBeUndefined();
  expect(host.server.currentBotId()).toBe(keep);
  expect(routinesOf(gone)).toHaveLength(0);
  expect(routinesOf(keep)).toHaveLength(1);
  expect(activityOf(gone)).toHaveLength(0);
  const botsDir = join(host.dataRoot, "bots");
  expect(existsSync(join(botsDir, gone))).toBe(false);
  const trashed = readdirSync(join(botsDir, ".trash"));
  expect(trashed).toHaveLength(1);
  expect(trashed[0]).toStartWith(gone);
  expect(existsSync(join(botsDir, ".trash", trashed[0]!, "bot.json"))).toBe(true);
  expect((await host.ui("/api/open", { botId: gone })).status).toBe(404);
});

test("deleting the only bot leaves no open bot, and a new bot can still be made", async () => {
  const only = host.createBot("Only");
  expect((await host.ui("/api/open", { botId: only })).status).toBe(200);
  expect((await host.ui("/api/bots/delete", { botId: only })).status).toBe(200);
  expect(host.server.currentBotId()).toBeUndefined();
  const created = await host.ui("/api/bots/new", {
    name: "Next",
    shape: SHAPE_NAMES[0],
    color: COLOR_NAMES[0],
  });
  expect(created.status).toBe(200);
});

test("an unknown bot answers 404 and a working bot is refused with 409 and kept", async () => {
  expect((await host.ui("/api/bots/delete", { botId: "nope" })).status).toBe(404);

  const bot = host.createBot("Busy");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  host.hold();
  expect((await host.ui("/api/send", { text: "work" })).status).toBe(200);
  await host.until(() => host.messagesOf(bot).length === 1);
  expect((await host.ui("/api/bots/delete", { botId: bot })).status).toBe(409);
  expect(getBot(host.dataRoot, bot)).toBeDefined();
  host.release();
});

test("a deleted bot's open handoffs fail, the other bot is told, and it no longer lists the deleted one", async () => {
  const a = host.createBot("Alice", "plans");
  const b = host.createBot("Bob", "searches");
  const alice = await host.actAs(a);
  const { handoff_id } = parse<{ handoff_id: string }>(
    await alice.call("hand_off", { to: b, title: "Flights", brief: BRIEF }),
  );
  await host.until(() => host.messagesOf(b).length === 1);
  // The fake CLI has the brief before the turn ends; the host refuses to delete a bot until the turn has.
  await host.until(() => !host.server.isWorking(b));

  expect((await host.ui("/api/bots/delete", { botId: b })).status).toBe(200);
  await host.until(() => host.messagesOf(a).length === 1);
  expect(host.messagesOf(a)[0]).toContain(
    `<handoff-update id="${handoff_id}" from="Bob" status="failed">`,
  );
  const bots = parse<{ id: string }[]>(await alice.call("list_bots"));
  expect(bots.map((x) => x.id)).not.toContain(b);
});

test("deleting a bot removes the usage marks of all its sessions and no other bot's", async () => {
  const keep = host.createBot("Keep");
  const gone = host.createBot("Gone");
  const marks = () => {
    const db = new Database(join(host.dataRoot, "tomte.db"), { readonly: true });
    try {
      return db
        .query<{ session_id: string; bot_id: string | null }, []>(
          "SELECT session_id, bot_id FROM session_usage_marks ORDER BY session_id",
        )
        .all();
    } finally {
      db.close();
    }
  };
  /** One chat turn of the open bot; the meter marks it under the bot's current session, and `marked` is how many marks exist after it. */
  const chat = async (botId: string, cost: number, marked: number) => {
    expect((await host.ui("/api/open", { botId })).status).toBe(200);
    host.setUsage({ cost });
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => marks().length === marked);
    await host.until(() => !host.server.isWorking(botId));
  };

  await chat(keep, 0.1, 1);
  await chat(gone, 0.2, 2);
  // A second session of the deleted bot: /new keeps the first one's mark.
  expect((await host.ui("/api/session/new", {})).status).toBe(200);
  await chat(gone, 0.3, 3);
  const sessionsOf = (botId: string) => getBot(host.dataRoot, botId)!.sessions;
  expect(sessionsOf(gone)).toHaveLength(2);
  expect(marks().map((m) => m.bot_id)).toEqual(
    expect.arrayContaining([keep, gone, gone]) as (string | null)[],
  );

  // A mark from before the host kept the bot id: its session is found through the bot's own session list.
  const legacy = new Database(join(host.dataRoot, "tomte.db"));
  legacy
    .query("UPDATE session_usage_marks SET bot_id = NULL WHERE session_id = ?")
    .run(sessionsOf(gone)[0]!);
  legacy.close();
  const kept = marks().filter((m) => m.bot_id === keep);
  expect(kept).toHaveLength(1);

  await host.until(() => !host.server.isWorking(gone));
  expect((await host.ui("/api/bots/delete", { botId: gone })).status).toBe(200);

  expect(marks()).toEqual(kept);
});
