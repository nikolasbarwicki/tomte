import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelLinkCodeResponse } from "@tomte/contract/api";
import { UPDATING } from "@tomte/contract/update";

import { VERSION } from "../harness/index.ts";
import { startFakeReleaseFeed, type FakeReleaseFeed } from "../testing/fake-release-feed.ts";
import { fakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

setDefaultTimeout(60_000);

const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const REMOTE = ["--mode", "remote", "--secrets-key-file", "/etc/tomte-test/secrets.key"];

let host: HandoffHost | undefined;
let tg: FakeTelegram | undefined;
let watcher: EventsWatch | undefined;
let feed: FakeReleaseFeed | undefined;
let dataRoot: string | undefined;
afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await host?.stop();
  await tg?.stop();
  host = undefined;
  tg = undefined;
  feed?.stop();
  feed = undefined;
  if (dataRoot !== undefined) rmSync(dataRoot, { recursive: true, force: true });
});

/** A server with the update helper, 0.2.0 on offer, one bot working on a turn that does not end until `release()`, and the owner linked on a fake Telegram. */
async function start() {
  feed = startFakeReleaseFeed();
  feed.publish("0.2.0");
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "update-ui-")));
  const root = dataRoot;
  tg = fakeTelegram();
  const t = tg;
  const h = await startHandoffHost([...REMOTE, "--data-root", root], undefined, undefined, {
    upkeep: {
      confPath: feed.conf(root),
      checkEveryMs: 3_600_000,
      gatePollMs: 20,
      resultPollMs: 20,
    },
    telegram: { baseUrl: t.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    notices: { retryMs: 20 },
  });
  host = h;
  watcher = await watchEvents(h);
  const w = watcher;
  const update = () => w.hostStatus()?.update;
  await h.until(() => update()?.status === "available");

  expect((await h.ui("/api/channels/telegram/token", { token: t.token })).status).toBe(200);
  await h.until(() => t.of("getUpdates").length > 0);
  const { code } = ChannelLinkCodeResponse.parse(
    await (await h.ui("/api/channels/link-code", { channel: "telegram" })).json(),
  );
  const id = t.message(owner, code);
  await h.until(() =>
    t.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
  );
  await h.until(() => t.texts().length === 1);

  const bot = h.createBot("Busy");
  expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);
  h.hold();
  expect((await h.ui("/api/send", { text: "work" })).status).toBe(200);
  await h.until(() => h.messagesOf(bot).length === 1);

  const updates = join(root, "updates");
  const run = (action: object) => h.ui("/api/updates/run", action);
  /** The root helper's side: answers the request on disk. */
  const helperAnswers = (result: object) => {
    const { id: requestId } = JSON.parse(readFileSync(join(updates, "request.json"), "utf8"));
    writeFileSync(
      join(updates, "result.json"),
      JSON.stringify({ requestId, finishedAt: Date.now(), ...result }),
    );
  };
  /** What the owner's phone got after the link confirmation, once a message that was not sent has had time to arrive. */
  const phone = async () => {
    await Bun.sleep(300);
    return t.texts().slice(1);
  };
  return { h, w, bot, update, updates, run, helperAnswers, phone };
}

test("update when idle: new work is refused while it drains, the request waits for the turn, and a failed result is told once", async () => {
  const { h, bot, update, updates, run, helperAnswers, phone, w } = await start();

  const drain = await run({ op: "apply", when: "idle" });
  expect(drain.status).toBe(200);
  expect(await drain.json()).toMatchObject({ status: "draining", version: "0.2.0", running: 1 });
  await h.until(() => update()?.status === "draining");

  // A new message and a manual routine run are refused; nothing reaches the helper while the turn runs.
  const refused = await h.ui("/api/send", { text: "more" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: UPDATING });
  const routine = await h.ui("/api/routines/create", {
    botId: bot,
    name: "daily",
    instruction: "check the news",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  });
  const { id } = (await routine.json()) as { id: string };
  const manual = await h.ui("/api/routines/run", { id });
  expect(manual.status).toBe(409);
  expect(await manual.json()).toEqual({ error: UPDATING });
  await Bun.sleep(100);
  expect(existsSync(join(updates, "request.json"))).toBe(false);
  expect(existsSync(join(updates, "pre-0.2.0.db"))).toBe(false);

  h.release();
  await h.until(() => existsSync(join(updates, "request.json")));
  expect(JSON.parse(readFileSync(join(updates, "request.json"), "utf8"))).toEqual({
    kind: "apply",
    id: expect.any(String),
    version: "0.2.0",
  });
  await h.until(() => update()?.status === "applying");
  expect(update()).toEqual({ status: "applying", version: "0.2.0" });
  // The snapshot is a database this host's own schema, taken before the request.
  const snapshot = new Database(join(updates, "pre-0.2.0.db"), { readonly: true });
  expect(snapshot.query("SELECT count(*) AS n FROM sqlite_master").get()).not.toEqual({ n: 0 });
  snapshot.close();

  helperAnswers({
    outcome: "reverted",
    version: "0.2.0",
    reason: "the new host never answered",
    rolledBackTo: "0.1.0",
    snapshotRestored: true,
  });
  await h.until(() => update()?.status === "failed");
  expect(w.hostStatus()?.problems).toEqual([
    { kind: "update-failed", version: "0.2.0", rolledBackTo: "0.1.0" },
  ]);
  const messages = await phone();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Update to 0.2.0 failed, rolled back to 0.1.0");

  // The gate is open again, and acknowledging the failure clears the problem.
  expect((await h.ui("/api/send", { text: "back" })).status).toBe(200);
  expect(await (await run({ op: "cancel" })).json()).toMatchObject({ status: "available" });
  await h.until(() => w.hostStatus()?.problems.length === 0);
  expect(await phone()).toHaveLength(1);
});

test("cancelling a drain reopens the host to messages and nothing is written for the helper", async () => {
  const { h, update, updates, run } = await start();
  await run({ op: "apply", when: "idle" });
  await h.until(() => update()?.status === "draining");
  expect((await h.ui("/api/send", { text: "x" })).status).toBe(409);

  expect(await (await run({ op: "cancel" })).json()).toMatchObject({ status: "available" });
  await h.until(() => update()?.status === "available");
  // The bot is still busy, so the message waits behind the turn instead of being refused.
  expect(await (await h.ui("/api/send", { text: "x" })).json()).toMatchObject({
    outcome: "queued",
  });
  h.release();
  await Bun.sleep(150);
  expect(existsSync(join(updates, "request.json"))).toBe(false);
});

test("update now writes the request while the turn still runs", async () => {
  const { h, bot, update, updates, run } = await start();
  const res = await run({ op: "apply", when: "now" });
  expect(await res.json()).toEqual({ status: "applying", version: "0.2.0" });
  expect(existsSync(join(updates, "request.json"))).toBe(true);
  expect(existsSync(join(updates, "pre-0.2.0.db"))).toBe(true);
  expect(h.server.isWorking(bot)).toBe(true);
  await h.until(() => update()?.status === "applying");
  h.release();
});

/** Posts a question event to a bot; the fake CLI receives it as the message of a turn once the host delivers it. */
async function postEvent(h: HandoffHost, botId: string) {
  const { token } = (await (await h.ui("/api/bots/events-token", { botId })).json()) as {
    token: string;
  };
  const res = await fetch(`${h.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key: "k1",
      source: { id: "hooks", label: "hooks" },
      title: "Deploy?",
    }),
  });
  expect(res.status).toBe(202);
}

test("an event that arrives while the host drains starts no turn until the gate reopens", async () => {
  const { h, update, run } = await start();
  const idle = h.createBot("Idle");
  await run({ op: "apply", when: "idle" });
  await h.until(() => update()?.status === "draining");

  await postEvent(h, idle);
  await Bun.sleep(300);
  expect(h.messagesOf(idle)).toEqual([]);
  expect(h.server.isWorking(idle)).toBe(false);

  await run({ op: "cancel" });
  await h.until(() => h.messagesOf(idle).length === 1);
  expect(h.messagesOf(idle)[0]).toContain("Deploy?");
  h.release();
});

test("an event that arrives while the helper works starts no turn, and neither does a result that replaces the host", async () => {
  const { h, update, run, helperAnswers } = await start();
  const idle = h.createBot("Idle");
  await run({ op: "apply", when: "now" });
  await h.until(() => update()?.status === "applying");

  await postEvent(h, idle);
  helperAnswers({ outcome: "updated", from: "0.1.0", version: "0.2.0" });
  await Bun.sleep(300);
  expect(h.messagesOf(idle)).toEqual([]);
  expect(update()?.status).toBe("applying");
  expect((await h.ui("/api/send", { text: "late" })).status).toBe(409);

  helperAnswers({ outcome: "failed", version: "0.2.0", reason: "no disk" });
  await h.until(() => update()?.status === "failed");
  await h.until(() => h.messagesOf(idle).length === 1);
  h.release();
});

test("an action that does not apply is refused with its reason, and the automatic setting reaches every page", async () => {
  const { h, w, run } = await start();
  const nothing = await run({ op: "bogus" });
  expect(nothing.status).toBe(400);

  const on = await run({ op: "auto", enabled: true });
  expect(on.status).toBe(200);
  await h.until(() => w.hostStatus()?.autoUpdate === true);
  expect((await run({ op: "auto", enabled: false })).status).toBe(200);
  await h.until(() => w.hostStatus()?.autoUpdate === false);
  h.release();
});

/**
 * A server that was updated to this version by the helper: its last result names the binaries (the earlier one at `previous`'s
 * schema), and the snapshot taken before the update is there when asked for. Nothing newer is on offer, and one bot is open.
 */
async function startUpdated(o: { running: number; previous: number; snapshot: boolean }) {
  feed = startFakeReleaseFeed();
  feed.publish(VERSION);
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rollback-ui-")));
  const root = dataRoot;
  const updates = join(root, "updates");
  mkdirSync(updates, { recursive: true });
  if (o.snapshot) writeFileSync(join(updates, `pre-${VERSION}.db`), "snapshot");
  writeFileSync(
    join(updates, "result.json"),
    JSON.stringify({
      requestId: "the-update",
      finishedAt: Date.now(),
      outcome: "updated",
      from: "0.0.1",
      version: VERSION,
      running: { version: VERSION, schemaVersion: o.running },
      previous: { version: "0.0.1", schemaVersion: o.previous },
    }),
  );
  const h = await startHandoffHost([...REMOTE, "--data-root", root], undefined, undefined, {
    upkeep: {
      confPath: feed.conf(root),
      checkEveryMs: 3_600_000,
      gatePollMs: 20,
      resultPollMs: 20,
    },
  });
  host = h;
  watcher = await watchEvents(h);
  const w = watcher;
  await h.until(() => w.hostStatus()?.update.status === "current");
  const bot = h.createBot("Idle");
  expect((await h.ui("/api/open", { botId: bot })).status).toBe(200);
  const run = (action: object) => h.ui("/api/updates/run", action);
  return { h, w, updates, run };
}

test("a rollback to a version that opens this database is offered, drains and goes to the helper as a request", async () => {
  const { h, w, updates, run } = await startUpdated({ running: 9, previous: 9, snapshot: true });
  await h.until(() => w.hostStatus()?.rollbackTo === "0.0.1");
  expect(w.hostStatus()?.restoreTo).toBeUndefined();

  const res = await run({ op: "rollback", when: "idle", restoreSnapshot: false });
  expect(res.status).toBe(200);
  await h.until(() => w.hostStatus()?.update.status === "applying");
  expect(w.hostStatus()?.update).toEqual({ status: "applying", version: "0.0.1", rollback: true });
  expect(w.hostStatus()?.rollbackTo).toBeUndefined();
  expect(JSON.parse(readFileSync(join(updates, "request.json"), "utf8"))).toEqual({
    kind: "rollback",
    id: expect.any(String),
  });
  expect(existsSync(join(updates, `pre-${VERSION}.db`))).toBe(true);
  const late = await h.ui("/api/send", { text: "late" });
  expect(late.status).toBe(409);
  expect(await late.json()).toEqual({ error: UPDATING });
});

test("a refused rollback is a problem in its own wording until it is dismissed", async () => {
  const { h, w, updates, run } = await startUpdated({ running: 9, previous: 9, snapshot: false });
  await run({ op: "rollback", when: "now", restoreSnapshot: false });
  const { id: requestId } = JSON.parse(readFileSync(join(updates, "request.json"), "utf8"));
  writeFileSync(
    join(updates, "result.json"),
    JSON.stringify({
      requestId,
      finishedAt: Date.now(),
      outcome: "refused",
      reason: "no previous version is kept",
    }),
  );
  await h.until(() => w.hostStatus()?.update.status === "failed");
  expect(w.hostStatus()?.problems).toEqual([
    { kind: "update-failed", version: "0.0.1", rollback: true },
  ]);
  expect((await h.ui("/api/send", { text: "back" })).status).toBe(200);
  expect(await (await run({ op: "cancel" })).json()).toMatchObject({ status: "current" });
  await h.until(() => w.hostStatus()?.problems.length === 0);
});

test("across a schema change the page is offered a restore with the snapshot's date, and without the confirmation nothing happens", async () => {
  const { h, w, updates, run } = await startUpdated({ running: 9, previous: 8, snapshot: true });
  await h.until(() => w.hostStatus()?.restoreTo !== undefined);
  expect(w.hostStatus()?.rollbackTo).toBeUndefined();
  const { mtimeMs } = statSync(join(updates, `pre-${VERSION}.db`));
  expect(w.hostStatus()?.restoreTo).toEqual({ version: "0.0.1", snapshotAt: mtimeMs });

  const refused = await run({ op: "rollback", when: "now", restoreSnapshot: false });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: expect.stringContaining("ask for that explicitly"),
  });
  expect(existsSync(join(updates, "request.json"))).toBe(false);
  expect(readFileSync(join(updates, `pre-${VERSION}.db`), "utf8")).toBe("snapshot");
  expect(w.hostStatus()?.update.status).toBe("current");
  expect((await h.ui("/api/send", { text: "still open" })).status).toBe(200);

  const confirmed = await run({ op: "rollback", when: "now", restoreSnapshot: true });
  expect(confirmed.status).toBe(200);
  expect(JSON.parse(readFileSync(join(updates, "request.json"), "utf8"))).toEqual({
    kind: "rollback",
    id: expect.any(String),
    restoreSnapshot: true,
  });
});

test("an earlier version that cannot open the database is not offered without its snapshot", async () => {
  const { w, run } = await startUpdated({ running: 9, previous: 8, snapshot: false });
  expect(w.hostStatus()?.rollbackTo).toBeUndefined();
  expect(w.hostStatus()?.restoreTo).toBeUndefined();
  expect((await run({ op: "rollback", when: "now", restoreSnapshot: true })).status).toBe(409);
});
