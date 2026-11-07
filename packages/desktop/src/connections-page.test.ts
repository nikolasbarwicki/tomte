import { describe, expect, test } from "bun:test";

import { ConnectionError } from "./connection-error.ts";
import {
  CONNECTIONS_ORIGIN,
  createConnectionsPages,
  type PageConnections,
} from "./connections-page.ts";

const EVIL = `<img src=x onerror=alert(1)>"'&`;

function fakeConnections(overrides: Partial<PageConnections> = {}): PageConnections {
  return {
    list: async () => [
      { id: "local", name: "This computer", origin: "http://127.0.0.1:4100", active: true },
      { id: "p1", name: EVIL, origin: "https://work.example.com", active: false },
    ],
    add: async () => ({
      id: "p1",
      name: "Work",
      origin: "https://work.example.com",
      active: false,
    }),
    connect: async () => {},
    forget: async () => "forgotten",
    ...overrides,
  };
}

const post = (path: string, fields: Record<string, string>) =>
  new Request(`${CONNECTIONS_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
const get = (path = "/") => new Request(`${CONNECTIONS_ORIGIN}${path}`);

/** Follows the 303 a form post answers with, as the window does. */
async function posted(pages: ReturnType<typeof createConnectionsPages>, request: Request) {
  const response = await pages.handle(request);
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(location.startsWith(`${CONNECTIONS_ORIGIN}/?m=`)).toBe(true);
  return {
    location,
    html: await (await pages.handle(get(location.slice(CONNECTIONS_ORIGIN.length)))).text(),
  };
}

describe("the list page", () => {
  test("escapes every interpolated string and sends a strict CSP", async () => {
    const pages = createConnectionsPages(fakeConnections());
    const response = await pages.handle(get());
    const html = await response.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toStartWith("default-src 'none'; style-src 'sha256-");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("offers Connect on the other profile, a connected badge on the active one and Forget only for remotes", async () => {
    const html = await (await createConnectionsPages(fakeConnections()).handle(get())).text();
    expect(html.match(/action="\/connect"/g)).toHaveLength(1);
    expect(html.match(/action="\/forget"/g)).toHaveLength(1);
    expect(html).toContain("connected");
    expect(html).toContain('action="/add"');
  });

  test("an unknown message id shows no message", async () => {
    const html = await (
      await createConnectionsPages(fakeConnections()).handle(get("/?m=nope"))
    ).text();
    expect(html).not.toContain('class="notice');
  });
});

describe("form posts", () => {
  test("add acts, then redirects to the list with only a message id", async () => {
    const calls: unknown[] = [];
    const pages = createConnectionsPages(
      fakeConnections({
        add: async (input) => {
          calls.push(input);
          return { id: "p", name: "Work", origin: "https://w", active: false };
        },
      }),
    );
    const { location, html } = await posted(
      pages,
      post("/add", { name: "Work", url: "https://work.example.com", code: "ABCD-EFGH-IJKL" }),
    );
    expect(calls).toEqual([
      { name: "Work", url: "https://work.example.com", code: "ABCD-EFGH-IJKL" },
    ]);
    expect(location).not.toContain("ABCD");
    expect(html).toContain("Added &quot;Work&quot;");
  });

  test("a failed add shows the error, refills name and address, never the code", async () => {
    const pages = createConnectionsPages(
      fakeConnections({
        add: async () => {
          throw new ConnectionError(`bad <b>code</b>`);
        },
      }),
    );
    const { html } = await posted(
      pages,
      post("/add", { name: "Work", url: "https://work.example.com", code: "SECRET-CODE" }),
    );
    expect(html).toContain("bad &lt;b&gt;code&lt;/b&gt;");
    expect(html).toContain('value="Work"');
    expect(html).toContain('value="https://work.example.com"');
    expect(html).not.toContain("SECRET-CODE");
  });

  test("an unexpected failure is shown too instead of failing the request", async () => {
    const pages = createConnectionsPages(
      fakeConnections({
        connect: async () => {
          throw new Error("disk on fire");
        },
      }),
    );
    expect((await posted(pages, post("/connect", { id: "p1" }))).html).toContain(
      "Something went wrong: disk on fire",
    );
  });

  test("connect passes the id", async () => {
    const ids: string[] = [];
    const pages = createConnectionsPages(
      fakeConnections({ connect: async (id) => void ids.push(id) }),
    );
    expect((await posted(pages, post("/connect", { id: "p1" }))).html).toContain("Connected.");
    expect(ids).toEqual(["p1"]);
  });

  test("forget on an unreachable host asks before forgetting without revoking", async () => {
    const calls: unknown[] = [];
    const pages = createConnectionsPages(
      fakeConnections({
        forget: async (id, options) => {
          calls.push([id, options?.withoutRevoking]);
          return options?.withoutRevoking
            ? "forgotten"
            : { unreachable: "Could not reach the host." };
        },
      }),
    );
    const first = await posted(pages, post("/forget", { id: "p1" }));
    expect(first.html).toContain("Forget without revoking");
    expect(first.html).toContain("stays valid on the host");
    const second = await posted(pages, post("/forget", { id: "p1", withoutRevoking: "1" }));
    expect(second.html).toContain("Connection forgotten.");
    expect(calls).toEqual([
      ["p1", false],
      ["p1", true],
    ]);
  });

  test("other paths and methods are 404", async () => {
    const pages = createConnectionsPages(fakeConnections());
    expect((await pages.handle(post("/wipe", {}))).status).toBe(404);
    expect((await pages.handle(get("/add"))).status).toBe(404);
  });

  test("notice() messages can be shown by id, and old ones are dropped", async () => {
    const pages = createConnectionsPages(fakeConnections());
    const first = pages.notice("error", "first");
    for (let i = 0; i < 25; i++) pages.notice("ok", `later ${i}`);
    const html = (id: string) => pages.handle(get(`/?m=${id}`)).then((r) => r.text());
    expect(await html(first)).not.toContain("first");
    expect(await html(pages.notice("error", "fresh <b>"))).toContain("fresh &lt;b&gt;");
  });
});
