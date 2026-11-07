import { describe, expect, test } from "bun:test";

import { readSidecarInput } from "./sidecar-stdin.ts";

/** A stream of the given chunks that then ends, or fails when `failWith` is set. */
function stream(chunks: string[], failWith?: Error) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      if (failWith) controller.error(failWith);
      else controller.close();
    },
  });
}

describe("the sidecar's stdin", () => {
  test("the first line is the token even when it arrives in pieces or with a CRLF ending", async () => {
    const input = readSidecarInput(stream(["abc", "def\r", "\nlater lines are dropped\n"]));
    expect(await input.firstLine).toBe("abcdef");
    await input.ended;
  });

  test("ending before a full line leaves no first line, and a partial line is not a token", async () => {
    const input = readSidecarInput(stream(["no newline"]));
    expect(await input.firstLine).toBeUndefined();
    await input.ended;
  });

  test("a line that never ends is cut off instead of collected without bound", async () => {
    const input = readSidecarInput(stream(["x".repeat(5000)]));
    expect((await input.firstLine)!.length).toBeLessThan(5000);
    await input.ended;
  });

  test("a failed pipe ends the input the way a closed one does", async () => {
    const input = readSidecarInput(stream(["tok"], new Error("EPIPE")));
    expect(await input.firstLine).toBeUndefined();
    await input.ended;
  });
});
