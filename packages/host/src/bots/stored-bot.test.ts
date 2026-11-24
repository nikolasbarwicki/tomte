import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAvatar } from "@tomte/contract/avatars";
import { z } from "zod";

import {
  createBot,
  getBot,
  newSession,
  setChatMode,
  setChiefOfStaff,
  setModelSettings,
} from "./index.ts";

let dataRoot: string;
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "stored-bot-"));
});
afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

const file = (id: string) => join(dataRoot, "bots", id, "bot.json");
const rewrite = (id: string, edit: (stored: Record<string, unknown>) => void) => {
  const stored = JSON.parse(readFileSync(file(id), "utf8"));
  edit(stored);
  writeFileSync(file(id), JSON.stringify(stored));
};

test("a bot.json from before sessions, browser settings, avatars, chat modes, model settings and the Chief of Staff switch reads with their defaults", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    delete s.sessions;
    delete s.browser;
    delete s.avatar;
    delete s.chatMode;
    delete s.model;
    delete s.effort;
    delete s.chiefOfStaff;
  });
  expect(getBot(dataRoot, id)).toMatchObject({
    sessions: [id],
    browser: { enabled: false, headed: false },
    avatar: defaultAvatar(id),
    chatMode: "standard",
    model: "sonnet",
    effort: "medium",
    chiefOfStaff: false,
  });
});

test("a bot.json with a line-drawing avatar keeps its color and gets a shape derived from the id", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.avatar = { face: "crown", stroke: "teal" };
  });
  expect(getBot(dataRoot, id)?.avatar).toEqual({ shape: defaultAvatar(id).shape, color: "teal" });
});

test("the model and effort round-trip through bot.json and survive a stale copy being saved", () => {
  const stale = createBot(dataRoot, "Ada", "tests");
  setModelSettings(dataRoot, stale.id, { model: "opus" });
  setModelSettings(dataRoot, stale.id, { effort: "high" });

  newSession(dataRoot, stale);
  expect(getBot(dataRoot, stale.id)).toMatchObject({ model: "opus", effort: "high" });
});

test("the chat mode round-trips through bot.json and survives a stale copy being saved", () => {
  const stale = createBot(dataRoot, "Ada", "tests");
  expect(JSON.parse(readFileSync(file(stale.id), "utf8")).chatMode).toBe("standard");

  setChatMode(dataRoot, stale.id, "background_tasks");
  expect(getBot(dataRoot, stale.id)?.chatMode).toBe("background_tasks");

  newSession(dataRoot, stale);
  expect(stale.chatMode).toBe("background_tasks");
  expect(getBot(dataRoot, stale.id)).toMatchObject({ chatMode: "background_tasks" });
  expect(getBot(dataRoot, stale.id)?.sessions).toHaveLength(2);
});

test("the Chief of Staff flag survives a stale copy being saved", () => {
  const stale = createBot(dataRoot, "Ada", "tests");
  expect(setChiefOfStaff(dataRoot, stale.id, true)).toEqual([stale.id]);

  newSession(dataRoot, stale);
  expect(stale.chiefOfStaff).toBe(true);
  expect(getBot(dataRoot, stale.id)?.chiefOfStaff).toBe(true);
});

test("turning the Chief of Staff on clears it on every other bot and returns the ids that changed", () => {
  const ada = createBot(dataRoot, "Ada");
  const bea = createBot(dataRoot, "Bea");
  const cy = createBot(dataRoot, "Cy");
  expect(setChiefOfStaff(dataRoot, ada.id, true)).toEqual([ada.id]);
  // A hand edit, or an older host, left it on two bots.
  rewrite(cy.id, (s) => {
    s.chiefOfStaff = true;
  });

  expect(setChiefOfStaff(dataRoot, bea.id, true).sort()).toEqual([ada.id, cy.id, bea.id].sort());
  expect([ada, bea, cy].map((b) => getBot(dataRoot, b.id)?.chiefOfStaff)).toEqual([
    false,
    true,
    false,
  ]);

  expect(setChiefOfStaff(dataRoot, bea.id, true)).toEqual([]);
  expect(setChiefOfStaff(dataRoot, ada.id, false)).toEqual([]);
  expect(setChiefOfStaff(dataRoot, bea.id, false)).toEqual([bea.id]);
  expect(setChiefOfStaff(dataRoot, "00000000-0000-4000-8000-000000000000", true)).toEqual([]);
});

test("a bot.json with an unknown chat mode throws a ZodError", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.chatMode = "triple_loop";
  });
  expect(() => getBot(dataRoot, id)).toThrow(z.ZodError);
});

test("a bot.json with a field of the wrong type throws a ZodError", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.avatar = { shape: "nope", color: "ink" };
  });
  expect(() => getBot(dataRoot, id)).toThrow(z.ZodError);
});

test("a bot.json with an empty sessions list throws a ZodError rather than yielding a bot with no session", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.sessions = [];
  });
  expect(() => getBot(dataRoot, id)).toThrow(z.ZodError);
});

test("a bot.json from before the chat mode was renamed reads as background_tasks and is saved with the new name", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.chatMode = "double_loop";
  });
  expect(getBot(dataRoot, id)?.chatMode).toBe("background_tasks");
  setChiefOfStaff(dataRoot, id, true);
  expect(JSON.parse(readFileSync(file(id), "utf8")).chatMode).toBe("background_tasks");
});
