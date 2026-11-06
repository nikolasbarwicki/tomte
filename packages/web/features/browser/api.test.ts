import { afterEach, describe, expect, test } from "bun:test";

import { sendBrowserInput } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Request {
  key: string;
  answer(): void;
  fail(): void;
}

/** A host that holds every request until the test answers it, so the test decides which one finishes first. */
function host() {
  const requests: Request[] = [];
  globalThis.fetch = ((_path: string, init: RequestInit) => {
    const { key } = JSON.parse(typeof init.body === "string" ? init.body : "") as { key: string };
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    requests.push({
      key,
      answer: () => resolve(Response.json({})),
      fail: () => reject(new Error("network down")),
    });
    return promise;
  }) as unknown as typeof fetch;
  return requests;
}

/** Lets the promise chain behind `sendBrowserInput` run as far as it can. */
const advance = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const press = (key: string) => sendBrowserInput("bot", { kind: "keyboard", key });

describe("takeover input", () => {
  test("a key waits for the one before it, so typed text reaches the page in order", async () => {
    const requests = host();
    for (const key of ["t", "y", "p"]) press(key);
    await advance();
    expect(requests.map((r) => r.key)).toEqual(["t"]);

    requests[0]?.answer();
    await advance();
    expect(requests.map((r) => r.key)).toEqual(["t", "y"]);

    requests[1]?.answer();
    await advance();
    expect(requests.map((r) => r.key)).toEqual(["t", "y", "p"]);

    requests[2]?.answer();
    await advance();
  });

  test("a failed event is dropped and the ones after it still go out", async () => {
    const requests = host();
    for (const key of ["a", "b"]) press(key);
    await advance();
    requests[0]?.fail();
    await advance();
    expect(requests.map((r) => r.key)).toEqual(["a", "b"]);
  });
});
