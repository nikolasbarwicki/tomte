import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventAccess } from "@tomte/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

/** The sender is a program of its own package; the host only ever meets it as a client over HTTP, so it is run, not imported. */
const SENDER = join(import.meta.dir, "../../../notify/src/main.ts");

let host: HandoffHost;
let scratch: string;
let page: EventsWatch | undefined;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "notify-sender-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  page?.stop();
  page = undefined;
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

/** A bot with its events route as its harness would hand it over: the URL and the token in the environment. */
async function botWithRoute(name: string) {
  const botId = host.createBot(name);
  const res = await host.ui("/api/bots/events-token", { botId });
  const route = EventAccess.parse(await res.json());
  await host.ui("/api/open", { botId });
  return {
    botId,
    token: route.token,
    /** Runs the sender as a subprocess in a temp HOME, with only the route in its environment. */
    async send(...argv: string[]) {
      const child = Bun.spawn([process.execPath, SENDER, ...argv], {
        cwd: scratch,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: scratch,
          TOMTE_EVENTS_URL: route.url,
          TOMTE_EVENTS_TOKEN: route.token,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out: out.trim(), err: err.trim(), code };
    },
  };
}

describe("the sender against a real host", () => {
  test("a blocked report is a blocked event: it wakes the bot, needs the user and closes with the answer", async () => {
    const bot = await botWithRoute("Planner");
    page = await watchEvents(host);

    const sent = await bot.send(
      "blocked",
      "04-notify",
      "omp-7",
      "Waiting for the staging key\nIt is in 1Password.",
    );
    expect(sent).toEqual({ out: "ok", err: "", code: 0 });

    await host.until(() => host.messagesOf(bot.botId).length === 1);
    const [text] = host.messagesOf(bot.botId) as [string];
    expect(text).toMatch(/id=\S+ kind=blocked /);
    expect(text).toContain("Waiting for the staging key");
    expect(text).toContain("Task: 04-notify\nSession: omp-7");

    const id = /id=(\S+) kind=blocked/.exec(text)![1]!;
    await host.until(() => page!.stateOf(id) === "open");
    expect(page.rowOf(id)).toMatchObject({ kind: "blocked", source: "04-notify" });
    await host.until(() => page!.needsYou(bot.botId) === 1);
    await host.until(() => Object.values(page!.status(bot.botId)).includes("blocked"));

    const answered = await host.ui("/api/send", { text: "key sent", eventId: id });
    expect(answered.status).toBe(200);
    await host.until(() => page!.stateOf(id) === "acted");
    await host.until(() => page!.needsYou(bot.botId) === 0);
  });

  test("the same report sent again is a duplicate that succeeds and wakes nobody; --salt sends it anew", async () => {
    const bot = await botWithRoute("Planner");
    const argv = ["failed", "t1", "s1", "tests are red"];
    expect((await bot.send(...argv)).out).toBe("ok");
    await host.until(() => host.messagesOf(bot.botId).length === 1);
    expect(await bot.send(...argv)).toEqual({ out: "ok (duplicate)", err: "", code: 0 });
    expect((await bot.send("--salt", "retry 2", ...argv)).out).toBe("ok");
    await host.until(() => host.messagesOf(bot.botId).length === 2);
    expect(host.messagesOf(bot.botId)).toHaveLength(2);
  });

  test("completed arrives as done, and a progress report is the quiet kind", async () => {
    const bot = await botWithRoute("Planner");
    page = await watchEvents(host);
    expect((await bot.send("progress", "t1", "s1", "halfway")).code).toBe(0);
    expect((await bot.send("completed", "t1", "s1", "all merged")).code).toBe(0);
    await host.until(() => host.messagesOf(bot.botId).some((m) => m.includes("kind=done ")));
    await host.until(() => page!.needsYou(bot.botId) === 1);
    await host.until(() => Object.values(page!.status(bot.botId)).includes("done"));
  });

  test("a wrong token is refused with exit 3 and the host's words", async () => {
    const bot = await botWithRoute("Planner");
    const route = EventAccess.parse(
      await (await host.ui("/api/bots/events-token", { botId: bot.botId })).json(),
    );
    const child = Bun.spawn([process.execPath, SENDER, "progress", "t", "s", "m"], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TOMTE_EVENTS_URL: route.url,
        TOMTE_EVENTS_TOKEN: "not-the-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(3);
    expect(err).toContain("HTTP 401");
    expect(err).toContain("invalid event token");
  });
});
