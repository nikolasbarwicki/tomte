import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAvatar } from "@claudebot/contract/avatars";
import { z } from "zod";

import { createBot, getBot } from "./index.ts";

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

test("a bot.json from before sessions, browser settings and avatars reads with their defaults", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    delete s.sessions;
    delete s.browser;
    delete s.avatar;
  });
  expect(getBot(dataRoot, id)).toMatchObject({
    sessions: [id],
    browser: { enabled: false, headed: false },
    avatar: defaultAvatar(id),
  });
});

test("a bot.json with a field of the wrong type throws a ZodError", () => {
  const { id } = createBot(dataRoot, "Ada", "tests");
  rewrite(id, (s) => {
    s.avatar = { face: "nope", stroke: "ink" };
  });
  expect(() => getBot(dataRoot, id)).toThrow(z.ZodError);
});
