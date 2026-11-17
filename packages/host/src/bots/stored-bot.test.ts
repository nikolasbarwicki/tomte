import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAvatar } from "@tomte/contract/avatars";
import { z } from "zod";

import { createBot, getBot, newSession, setChatMode, setModelSettings } from "./index.ts";

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

test("a bot.json from before sessions, browser settings, avatars, chat modes and model settings reads with their defaults", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    delete s.sessions;
    delete s.browser;
    delete s.avatar;
    delete s.chatMode;
    delete s.model;
    delete s.effort;
  });
  expect(getBot(dataRoot, id)).toMatchObject({
    sessions: [id],
    browser: { enabled: false, headed: false },
    avatar: defaultAvatar(id),
    chatMode: "standard",
    model: "sonnet",
    effort: "medium",
  });
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

  setChatMode(dataRoot, stale.id, "double_loop");
  expect(getBot(dataRoot, stale.id)?.chatMode).toBe("double_loop");

  newSession(dataRoot, stale);
  expect(stale.chatMode).toBe("double_loop");
  expect(getBot(dataRoot, stale.id)).toMatchObject({ chatMode: "double_loop" });
  expect(getBot(dataRoot, stale.id)?.sessions).toHaveLength(2);
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
    s.avatar = { face: "nope", stroke: "ink" };
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
