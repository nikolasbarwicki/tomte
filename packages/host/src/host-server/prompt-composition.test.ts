import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setChatMode, setChiefOfStaff } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "prompt-composition-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

async function sendAndWait(botId: string, text: string) {
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => host.messagesOf(botId).length >= 1);
  await host.until(() => !host.server.isWorking(botId));
}

function expectOrdered(text: string, markers: string[]) {
  const positions = markers.map((marker) => {
    const pos = text.indexOf(marker);
    expect(pos, `expected prompt to contain ${JSON.stringify(marker)}`).toBeGreaterThanOrEqual(0);
    return pos;
  });
  for (let i = 1; i < positions.length; i++) {
    expect(
      positions[i - 1]!,
      `expected ${JSON.stringify(markers[i - 1])} before ${JSON.stringify(markers[i])}`,
    ).toBeLessThan(positions[i]!);
  }
}

describe("composed system prompts", () => {
  test("standard bot includes core behavior once and preserves routines, instructions, files and memory order", async () => {
    const id = host.createBot("Ada", "Researches travel options");
    await host.ui("/api/instructions/update", { text: "Keep prices in PLN." });
    await host.ui("/api/memory/update", { scope: "user", text: "Lives in Wroclaw." });
    await host.ui("/api/memory/update", {
      scope: "bot",
      botId: id,
      text: "Prefer direct flights.",
    });

    await sendAndWait(id, "hello");
    const prompt = defined(host.launches()[0], "launch").appendSystemPrompt ?? "";

    expect(prompt.split("## Core assistant behavior")).toHaveLength(2);
    expectOrdered(prompt, [
      "## Memory",
      "## Routines",
      "# This bot",
      "## Core assistant behavior",
      "### Voice & formatting",
      "### Proactivity & judgment",
      "### Epistemic honesty & calibration",
      "### Safety gates & untrusted data",
      "### Self-inspection",
      "# The user's instructions for every bot\nKeep prices in PLN.",
      "## Your files",
      "# User memory (about the user)\nLives in Wroclaw.",
      "# Bot memory (how you operate)\nPrefer direct flights.",
    ]);
  });

  test("background-tasks front, worker and researcher each receive core behavior once with expected ordering", async () => {
    const id = host.createBot("Dev", "Builds small tools");
    setChatMode(host.dataRoot, id, "background_tasks");
    await host.ui("/api/instructions/update", { text: "Always answer in Polish." });
    await host.ui("/api/memory/update", { scope: "user", text: "Prefers TypeScript." });
    await host.ui("/api/memory/update", { scope: "bot", botId: id, text: "Use bun." });

    host.loopScript({ steps: [{ result: "Cześć." }] });
    await sendAndWait(id, "cześć");

    const launch = defined(host.launches()[0], "launch");
    const frontPrompt = launch.appendSystemPrompt ?? "";
    const workerPrompt = defined(launch.agents?.worker, "worker agent").prompt;
    const researcherPrompt = defined(launch.agents?.researcher, "researcher agent").prompt;

    expect(frontPrompt.split("## Core assistant behavior")).toHaveLength(2);
    expect(frontPrompt).not.toContain("## Your files");
    expectOrdered(frontPrompt, [
      "Every action takes two beats",
      "## Memory",
      "## Routines",
      "# This bot",
      "## Core assistant behavior",
      "# The user's instructions for every bot\nAlways answer in Polish.",
      "# User memory (about the user)\nPrefers TypeScript.",
      "# Bot memory (how you operate)\nUse bun.",
    ]);

    expect(workerPrompt.split("## Core assistant behavior")).toHaveLength(2);
    expectOrdered(workerPrompt, [
      "posted to the user as a chat message",
      "# This bot",
      "## Core assistant behavior",
      "# The user's instructions for every bot\nAlways answer in Polish.",
      "## Your files",
      "# User memory (about the user)\nPrefers TypeScript.",
      "# Bot memory (how you operate)\nUse bun.",
    ]);

    expect(researcherPrompt.split("## Core assistant behavior")).toHaveLength(2);
    expectOrdered(researcherPrompt, [
      "## Core assistant behavior",
      "record_progress",
      "never slip back into English",
    ]);
  });

  test("Chief of Staff combines core behavior with delegation and drops the rigid 3-line footer", async () => {
    const id = host.createBot("Chief", "Coordinates all bots");
    setChiefOfStaff(host.dataRoot, id, true);
    await host.ui("/api/instructions/update", { text: "Use 24h time." });

    await sendAndWait(id, "status?");
    const prompt = defined(host.launches()[0], "launch").appendSystemPrompt ?? "";

    expect(prompt.split("## Core assistant behavior")).toHaveLength(2);
    expectOrdered(prompt, [
      "# This bot",
      "## Core assistant behavior",
      "# The user's instructions for every bot\nUse 24h time.",
      "## You are the owner's Chief of Staff",
      "## Your files",
    ]);
    expect(prompt).toContain("list_bots");
    expect(prompt).toContain("hand_off");
    expect(prompt).toContain("create_bot");
    expect(prompt).not.toContain("what you killed");
  });
});
