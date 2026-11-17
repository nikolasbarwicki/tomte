import { afterAll, beforeAll, expect, test } from "bun:test";

import { startHandoffHost, type HandoffHost } from "../../testing/test-host.ts";

let host: HandoffHost;
beforeAll(async () => {
  host = await startHandoffHost();
});
afterAll(() => host.stop());

const raw = (path: string, body: string) =>
  fetch(`${host.clientUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host.clientUrl, ...host.authHeaders },
    body,
  });

test("a body that is not JSON answers 400 with an error", async () => {
  const res = await raw("/api/open", "{not json");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "request body is not valid JSON" });
});

test("a JSON body that is not an object answers 400", async () => {
  const res = await raw("/api/open", "[1,2]");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "request body must be a JSON object" });
});

test.each([
  ["/api/bots/new", { name: "Ada", purpose: "", shape: "nope", color: "ink" }, "shape"],
  ["/api/bots/new", { name: " ", shape: "ball", color: "ink" }, "name required"],
  ["/api/bots/browser", { botId: "x", enabled: "yes" }, "enabled"],
  ["/api/open", { botId: 7 }, "botId"],
  ["/api/integrations/set-enabled", { id: "x", enabled: "yes" }, "enabled"],
  ["/api/routines/create", { botId: 7 }, "botId"],
])("%s rejects a field of the wrong shape with 400", async (path, body, field) => {
  const res = await host.ui(path, body);
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain(field);
});

test("an open bot's routes reject a bad body with 400", async () => {
  const botId = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  for (const [path, body] of [
    ["/api/effort", { effort: "turbo" }],
    ["/api/send", { text: "hi", mentions: "everyone" }],
  ] as const) {
    const res = await host.ui(path, body);
    expect(res.status).toBe(400);
  }
});
