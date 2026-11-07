import { afterEach, describe, expect, test } from "bun:test";

import { oauthFixture } from "../testing/fake-oauth-server.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const PUBLIC = "https://claudebot.example.com";
const MOVED = "https://claudebot.example.net";

let host: HandoffHost;
let provider: ReturnType<typeof oauthFixture>;
afterEach(async () => {
  await host.stop();
  await provider.server.stop(true);
});

const post = async <T>(path: string, body: object) => {
  const res = await host.ui(path, body);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

type Card = { id: string; state: string; tools: { name: string }[] };

/** What the web page does on Connect, then what the provider's redirect does: the integration ends up connected. */
async function signIn(id: string) {
  const { authorizeUrl } = await post<{ authorizeUrl: string }>("/api/integrations/connect-oauth", {
    id,
  });
  const x = provider.approve(authorizeUrl);
  const back = await fetch(
    `${host.clientUrl}/oauth/callback?code=${x.code}&state=${encodeURIComponent(x.state)}`,
  );
  expect(back.status).toBe(200);
  return x.a;
}

async function connected() {
  provider = oauthFixture();
  host = await startHandoffHost(["--public-url", PUBLIC]);
  const { id } = await post<Card>("/api/integrations/add-custom", {
    name: "oa",
    url: provider.url,
    transport: "http",
    oauth: true,
  });
  return { id, authorize: await signIn(id) };
}

const card = async (id: string) =>
  (await post<Card[]>("/api/integrations/list", {})).find((i) => i.id === id)!;

describe("OAuth sign-in against the public URL", () => {
  test("registers the client and asks for the code with a redirect URL built from the public URL", async () => {
    const { id, authorize } = await connected();
    expect(provider.registeredRedirects()).toEqual([[`${PUBLIC}/oauth/callback`]]);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/oauth/callback`);
    expect((await card(id)).state).toBe("connected");
  });

  test("a changed public URL makes the next connect register a new client for it", async () => {
    const { id, authorize: first } = await connected();
    await host.restart(["--public-url", MOVED]);

    const second = await signIn(id);
    expect(provider.registeredRedirects()).toEqual([
      [`${PUBLIC}/oauth/callback`],
      [`${MOVED}/oauth/callback`],
    ]);
    expect(second.searchParams.get("redirect_uri")).toBe(`${MOVED}/oauth/callback`);
    expect(second.searchParams.get("client_id")).not.toBe(first.searchParams.get("client_id"));
    expect((await card(id)).state).toBe("connected");

    await signIn(id);
    expect(provider.registrations()).toBe(2);
  });

  test("the stored tokens keep working after the public URL changes", async () => {
    const { id } = await connected();
    await host.restart(["--public-url", MOVED]);

    const probed = await post<Card>("/api/integrations/probe", { id });
    expect(probed.state).toBe("connected");
    expect(probed.tools.map((t) => t.name).sort()).toEqual(["delete_all", "lookup"]);
    expect(provider.registrations()).toBe(1);
  });
});
