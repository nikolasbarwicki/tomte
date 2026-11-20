import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_BEHAVIOR_INSTRUCTIONS } from "./behavior.ts";
import { CHIEF_OF_STAFF_INSTRUCTIONS } from "./chief-of-staff.ts";
import {
  botContext,
  createBot,
  frontContext,
  instructionsPath,
  setChiefOfStaff,
  writeMemory,
} from "./index.ts";

let dataRoot: string;
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "tomte-behavior-"));
});
afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

describe("CORE_BEHAVIOR_INSTRUCTIONS", () => {
  test("covers voice, language matching, proactivity, epistemic honesty, safety gates and self-inspection", () => {
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("### Voice & formatting");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("Match the user's language");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("Answer first");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("### Proactivity & judgment");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("Own the outcome");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("### Epistemic honesty & calibration");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("estimates explicitly as guesses");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("Nothing pushed.");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("### Safety gates & untrusted data");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("untrusted data");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("### Self-inspection");
    expect(CORE_BEHAVIOR_INSTRUCTIONS).toContain("clean grouped summary");
  });
});

describe("CHIEF_OF_STAFF_INSTRUCTIONS", () => {
  test("preserves delegation, create_bot and safety boundaries without the rigid 3-line footer mandate", () => {
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).toContain("## You are the owner's Chief of Staff");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).toContain("list_bots");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).toContain("hand_off");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).toContain("create_bot");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).toContain("chief_log.md");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).not.toContain("what you killed");
    expect(CHIEF_OF_STAFF_INSTRUCTIONS).not.toContain("Every report ends with three lines");
  });
});

describe("persona assembly", () => {
  test("botContext orders identity, core behavior, user instructions, Chief of Staff and files", () => {
    const bot = createBot(dataRoot, "Ada", "Helps plan weekly work");
    writeMemory(instructionsPath(dataRoot), "Prefer metric units.");
    setChiefOfStaff(dataRoot, bot.id, true);

    const text = botContext(dataRoot, bot).persona();
    const order = [
      "# This bot",
      "## Core assistant behavior",
      "# The user's instructions for every bot",
      "## You are the owner's Chief of Staff",
      "## Your files",
    ].map((heading) => text.indexOf(heading));

    for (const pos of order) expect(pos).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!).toBeLessThan(order[i]!);
    expect(text.split("## Core assistant behavior")).toHaveLength(2);
  });

  test("frontContext includes core behavior on both front persona and worker persona without duplicating it", () => {
    const bot = createBot(dataRoot, "Dev", "Builds prototypes");
    writeMemory(instructionsPath(dataRoot), "Use ISO dates.");

    const ctx = frontContext(dataRoot, bot);
    const front = ctx.persona();
    const worker = ctx.workerPersona();

    expect(front).toContain("## Core assistant behavior");
    expect(front).not.toContain("## Your files");
    expect(front.indexOf("## Core assistant behavior")).toBeLessThan(
      front.indexOf("# The user's instructions for every bot"),
    );

    expect(worker).toContain("## Core assistant behavior");
    expect(worker).toContain("## Your files");
    expect(worker.indexOf("## Core assistant behavior")).toBeLessThan(
      worker.indexOf("# The user's instructions for every bot"),
    );
    expect(worker.indexOf("# The user's instructions for every bot")).toBeLessThan(
      worker.indexOf("## Your files"),
    );
    expect(worker.split("## Core assistant behavior")).toHaveLength(2);
  });
});
