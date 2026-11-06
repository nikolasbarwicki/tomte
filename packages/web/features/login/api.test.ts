import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { probeSession } from "@/host/api.ts";
import { sessionStore } from "@/host/session.ts";

import { pair } from "./api.ts";

const realFetch = globalThis.fetch;
let requests: { path: string; body: unknown }[] = [];

/** Answers every request with `respond`, recording the path and JSON body. */
function host(respond: (path: string) => Response) {
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    requests.push({
      path: input,
      body: JSON.parse(typeof init?.body === "string" ? init.body : ""),
    });
    return respond(input);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
  sessionStore.set("unknown");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("an unpaired browser", () => {
  test("is sent to the login when the host answers 401", async () => {
    host(() => Response.json({ error: "pair this device first" }, { status: 401 }));
    await probeSession();
    expect(sessionStore.get()).toBe("unpaired");
  });

  test("is paired once the host accepts its first request", async () => {
    host(() => Response.json({}));
    await probeSession();
    expect(sessionStore.get()).toBe("paired");
  });

  test("pairs with a valid code and sends the code and device name", async () => {
    sessionStore.set("unpaired");
    host(() => Response.json({ deviceId: "d1", token: "t" }));
    expect(await pair("ABCD-EFGH-JKLM", "Work laptop")).toBeUndefined();
    expect(requests).toEqual([
      { path: "/api/pair", body: { code: "ABCD-EFGH-JKLM", name: "Work laptop" } },
    ]);
    expect(sessionStore.get()).toBe("paired");
  });

  test("stays on the login with the host's error when the code is wrong", async () => {
    sessionStore.set("unpaired");
    host(() => Response.json({ error: "invalid pairing code" }, { status: 401 }));
    expect(await pair("WRONG", "Work laptop")).toBe("invalid pairing code");
    expect(sessionStore.get()).toBe("unpaired");
  });
});

describe("a paired browser", () => {
  test("falls back to the login when the host revokes it mid-session", async () => {
    sessionStore.set("paired");
    host(() => Response.json({ error: "pair this device first" }, { status: 401 }));
    await probeSession();
    expect(sessionStore.get()).toBe("unpaired");
  });
});
