import { expect, test } from "bun:test";

import { noticeMessage } from "./notices.ts";

const failed = { kind: "run_failed", botId: "b1", routine: "Digest", error: "boom" } as const;

test("a failure and an interruption are worded apart", () => {
  expect(noticeMessage({ ...failed, interrupted: false }, "https://c.example").text).toBe(
    "Routine Digest failed: boom",
  );
  expect(
    noticeMessage(
      { ...failed, error: "app stopped during run", interrupted: true },
      "https://c.example",
    ).text,
  ).toBe("Routine Digest was interrupted: app stopped during run");
});

test("an error is cut to about 300 characters", () => {
  const { text } = noticeMessage(
    { ...failed, error: "x".repeat(1000), interrupted: false },
    "https://c.example",
  );
  expect(text.length).toBeLessThan(330);
  expect(text.endsWith("…")).toBe(true);
});

test("an expired park says what it waited for and that the run failed", () => {
  expect(
    noticeMessage(
      { kind: "park_expired", botId: "b1", routine: "Digest", wait: "approval for Bash" },
      "https://c.example",
    ).text,
  ).toBe("Digest: approval for Bash expired, so the run failed");
});

test("the link goes to the routines panel, and a loopback http public URL has none", () => {
  const n = { ...failed, interrupted: false };
  expect(noticeMessage(n, "https://c.example/").link?.url).toBe(
    "https://c.example/bots/b1?panel=routines",
  );
  expect(noticeMessage(n, "http://127.0.0.1:5173").link).toBeUndefined();
});

const result = {
  kind: "routine_result",
  botId: "b1",
  routine: "Digest",
  output: "3 new items",
} as const;

test("a routine's result is its name and its output", () => {
  expect(noticeMessage(result, "https://c.example").text).toBe("Digest: 3 new items");
});

test("a result's output is cut to about 800 characters", () => {
  const { text } = noticeMessage({ ...result, output: "x".repeat(2000) }, "https://c.example");
  expect(text.length).toBeLessThan(830);
  expect(text.endsWith("…")).toBe(true);
});

test("a run with no output is told as finished, with no summary", () => {
  expect(noticeMessage({ ...result, output: "" }, "https://c.example").text).toBe(
    "Digest finished",
  );
  expect(noticeMessage({ ...result, output: " \n " }, "https://c.example").text).toBe(
    "Digest finished",
  );
});
