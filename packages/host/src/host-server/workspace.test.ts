import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const BRIEF =
  "goal: plan; context: none; constraints: none; deliverable: a plan; done when: written";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "workspace-")));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

const workspace = () => join(host.dataRoot, "workspace");
const cwds = () => host.launches().map((l) => l.cwd);

describe("the Claude CLI's working directory", () => {
  test("an interactive chat runs it in the workspace directory inside the data root", async () => {
    const botId = host.createBot("Ada");
    expect((await host.ui("/api/open", { botId })).status).toBe(200);
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.launches().length === 1);

    expect(cwds()).toEqual([workspace()]);
    expect(cwds()).not.toContain(process.cwd());
  });

  test("a routine run runs it there, with no chat open", async () => {
    const botId = host.createBot("Ada");
    const created = await host.ui("/api/routines/create", {
      botId,
      name: "nightly",
      instruction: "check",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    const routine = (await created.json()) as { id: string };
    expect((await host.ui("/api/routines/run", { id: routine.id })).status).toBe(200);
    await host.until(() => host.launches().length === 1);

    expect(cwds()).toEqual([workspace()]);
  });

  test("a handoff delivery to a bot with no chat open runs it there", async () => {
    const a = host.createBot("Alice");
    const b = host.createBot("Bob");
    const alice = await host.actAs(a);
    expect((await alice.call("hand_off", { to: b, title: "t", brief: BRIEF })).isError).toBe(false);
    await host.until(() => host.messagesOf(b).length === 1);

    expect(cwds()).toEqual([workspace()]);
  });
});
