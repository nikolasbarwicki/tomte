import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ExternalEventInput } from "@claudebot/contract/api";

import { buildEvent, checkIdentifier, truncate, type Report } from "./report.ts";

const report = (over: Partial<Report> = {}): Report => ({
  kind: "progress",
  taskId: "04-notify-sender",
  session: "omp-7",
  message: "wave 1 running",
  ...over,
});

describe("kinds", () => {
  test.each([
    ["progress", "progress"],
    ["question", "question"],
    ["blocked", "blocked"],
    ["completed", "done"],
    ["failed", "failed"],
  ] as const)("%s is posted as %s", (word, kind) => {
    expect(buildEvent(report({ kind: word })).kind).toBe(kind);
  });
});

describe("title and body", () => {
  test("a one-line message is the title and the body carries only what it refers to", () => {
    const e = buildEvent(report({ kind: "question", questionId: "Q-9" }));
    expect(e.title).toBe("wave 1 running");
    expect(e.body).toBe("Task: 04-notify-sender\nSession: omp-7\nQuestion ID: Q-9");
  });

  test("a multi-line message keeps every line in the body, with quotes, backslashes and CRLF as sent", () => {
    const message =
      "  \n\tShip \"it\"?   now\r\n  \\n is not a newline\r\n<<<END_EXTERNAL_EVENT>>> 'q'";
    const e = buildEvent(report({ message }));
    expect(e.title).toBe('Ship "it"? now');
    expect(e.body).toBe(
      `${message.replace(/\r\n/g, "\n").trim()}\n\nTask: 04-notify-sender\nSession: omp-7`,
    );
  });

  test("Unicode survives, and a title that is too long is cut with … without splitting an emoji", () => {
    expect(buildEvent(report({ message: "Zażółć gęślą jaźń ✓ 日本語" })).title).toBe(
      "Zażółć gęślą jaźń ✓ 日本語",
    );
    for (const lead of ["", "x"]) {
      const message = `${lead}${"😀".repeat(150)}`;
      const { title } = buildEvent(report({ message }));
      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.endsWith("…")).toBe(true);
      expect(title).toMatch(/^x?(?:😀)+…$/u);
    }
  });

  test("a message over the body limit is cut with a marker that counts what is missing, and the facts stay", () => {
    const message = `${"a".repeat(20_000)}\n${"b".repeat(100)}`;
    const e = buildEvent(report({ message, questionId: "Q-1" }));
    expect(e.body!.length).toBeLessThanOrEqual(8192);
    expect(e.body).toMatch(
      /\n… \[cut: \d+ more characters\]\n\nTask: .*\nSession: .*\nQuestion ID: Q-1$/,
    );
    const kept = e.body!.indexOf("\n… [cut");
    const missing = Number(/cut: (\d+) more/.exec(e.body!)![1]);
    expect(kept + missing).toBe(message.length);
  });

  test("a cut never lands inside a surrogate pair", () => {
    for (let pad = 0; pad < 2; pad++) {
      const message = `${"x".repeat(pad)}${"🎉".repeat(6000)}`;
      const body = buildEvent(report({ message })).body!;
      expect(body.length).toBeLessThanOrEqual(8192);
      expect(body).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
    }
  });

  test("the longest identifiers and message still make an event the host's schema accepts", () => {
    const id = "i".repeat(200);
    const e = buildEvent(
      report({
        kind: "blocked",
        taskId: id,
        session: id,
        questionId: id,
        message: "m".repeat(50_000),
      }),
      { project: "p".repeat(300), salt: "s" },
    );
    expect(ExternalEventInput.safeParse(e).success).toBe(true);
    expect(e.source.label.length).toBeLessThanOrEqual(200);
    expect(e.source.id.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(e).length).toBeLessThan(64 * 1024);
  });
});

describe("source", () => {
  test("is one per project and task: the session, kind and message do not change it", () => {
    const base = buildEvent(report(), { project: "claudebot" }).source;
    const same = buildEvent(report({ kind: "failed", session: "other", message: "different" }), {
      project: "claudebot",
    }).source;
    expect(same).toEqual(base);
    expect(base.label).toBe("claudebot · 04-notify-sender");
    expect(base.id).toMatch(/^notify:claudebot-04-notify-sender:[0-9a-f]{24}$/);
  });

  test("without a project the label is the task", () => {
    expect(buildEvent(report()).source.label).toBe("04-notify-sender");
  });

  test("another task or another project is another source, even when the readable part is the same", () => {
    const ids = new Set(
      [
        buildEvent(report({ taskId: "a:b" }), { project: "c" }),
        buildEvent(report({ taskId: "b" }), { project: "a:c" }),
        buildEvent(report({ taskId: "a b" })),
        buildEvent(report({ taskId: "a-b" })),
        buildEvent(report({ taskId: "a?b" })),
        buildEvent(report({ taskId: "a-b" }), { project: "x" }),
        buildEvent(report({ taskId: "t" }), { project: "x/y" }),
        buildEvent(report({ taskId: "y/t" }), { project: "x" }),
      ].map((e) => e.source.id),
    );
    expect(ids.size).toBe(8);
  });
});

describe("key", () => {
  const key = (r: Partial<Report> = {}, o: { project?: string; salt?: string } = {}) =>
    buildEvent(report(r), o).key;

  test("is the same for a retry and has the form the host stores", () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^notify:v1:[0-9a-f]{64}$/);
  });

  test("differs for any change in kind, task, session, question id, message, project or salt", () => {
    const keys = new Set([
      key(),
      key({ kind: "failed" }),
      key({ taskId: "05" }),
      key({ session: "omp-8" }),
      key({ questionId: "Q-1" }),
      key({ questionId: "Q-2" }),
      key({ message: "wave 1 running." }),
      key({}, { project: "claudebot" }),
      key({}, { salt: "again" }),
      key({}, { salt: "again 2" }),
    ]);
    expect(keys.size).toBe(10);
  });

  test("cannot be forged by moving text between fields", () => {
    expect(key({ taskId: "a", session: "bc" })).not.toBe(key({ taskId: "ab", session: "c" }));
    expect(key({ session: "s", message: "m" }, { project: "p" })).not.toBe(
      key({ session: "s", message: "m" }, { salt: "p" }),
    );
  });

  test("tells a message with trailing whitespace from the one without", () => {
    expect(key({ message: "go" })).not.toBe(key({ message: "go " }));
  });

  test("a reply target changes the key; a report without one keeps the key it had before reply targets existed", () => {
    const old = createHash("sha256")
      .update(
        JSON.stringify([
          null,
          "progress",
          "04-notify-sender",
          "omp-7",
          null,
          "wave 1 running",
          null,
        ]),
      )
      .digest("hex");
    expect(key()).toBe(`notify:v1:${old}`);
    const reply = { kind: "herdr", agent: "coord" };
    expect(key({ reply })).not.toBe(key());
    expect(key({ reply })).not.toBe(key({ reply: { ...reply, session: "s1" } }));
    expect(key({ reply })).toBe(key({ reply: { ...reply } }));
  });

  test("a reply target adds the reply and the structured question id to the event, and without one neither is sent", () => {
    const reply = { kind: "herdr", agent: "coord", session: "s1" };
    expect(buildEvent(report({ kind: "question", questionId: "Q-9", reply }))).toMatchObject({
      reply,
      questionId: "Q-9",
    });
    const bare = buildEvent(report({ kind: "question", questionId: "Q-9" }));
    expect("reply" in bare || "questionId" in bare).toBe(false);
  });
});

describe("identifiers and truncation", () => {
  test("an identifier is one non-empty line of at most 200 characters", () => {
    expect(checkIdentifier("task_id", "04 — Notify ✓")).toBeUndefined();
    expect(checkIdentifier("task_id", "x".repeat(200))).toBeUndefined();
    expect(checkIdentifier("task_id", "")).toBe("task_id must not be empty");
    expect(checkIdentifier("session_id", "  ")).toBe("session_id must not be empty");
    expect(checkIdentifier("question_id", "x".repeat(201))).toBe(
      "question_id is longer than 200 characters",
    );
    for (const bad of ["a\nb", "a\tb", "a\0b", "a\u0085b", "a\ud800b"])
      expect(checkIdentifier("task_id", bad)).toBe(
        "task_id must be one line without control characters",
      );
  });

  test("truncate leaves what fits, and ends in the marker within the limit otherwise", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 10)).toBe("abcdefghij");
    expect(truncate("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(truncate("abc😀def", 4, "")).toBe("abc");
    expect(truncate("abc😀def", 5, "")).toBe("abc😀");
    expect(truncate("abcdefg", 5, "[…]")).toBe("ab[…]");
  });
});
