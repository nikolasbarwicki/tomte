import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

// Built-in Gmail on a whole host: Connect through the HTTP routes against a loopback fake Google, then the fake Claude CLI calls the
// in-process `gmail` server the way the real CLI does (a permission request, then the MCP call) in a standard and a double-loop chat.
import { setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

const SECRET_SUBJECT = "Salary raise for Anna";
const SECRET_BODY = "You get 5000 PLN more from January";
const SECRET_ADDRESS = "anna@example.test";

let host: HandoffHost;
let google: FakeGoogle;
let logged: string[];
let restoreLogs: () => void;

beforeEach(async () => {
  google = fakeGoogle();
  google.thread("t1", [
    { id: "m1", from: `Anna <${SECRET_ADDRESS}>`, subject: SECRET_SUBJECT, text: SECRET_BODY },
    {
      id: "m2",
      from: "Me <me@example.test>",
      subject: `Re: ${SECRET_SUBJECT}`,
      html: "<p>Thanks!</p>",
    },
  ]);
  host = await startHandoffHost([], undefined, undefined, { google: google.endpoints });
  logged = [];
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.join(" "));
  });
  const out = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logged.push(a.join(" "));
  });
  restoreLogs = () => {
    err.mockRestore();
    out.mockRestore();
  };
});
afterEach(async () => {
  await host.stop();
  restoreLogs();
  await google.stop();
});

type Card = {
  id: string;
  catalogId: string | null;
  state: string;
  transport: { type: string; service?: string };
  tools: { name: string; policy: string; readOnly: boolean; locked: boolean }[];
};

const post = async <T>(path: string, body: object) => {
  const res = await host.ui(path, body);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const card = async () =>
  defined((await post<Card[]>("/api/integrations/list", {})).find((i) => i.catalogId === "gmail"));

/** What the web page does on Connect, then what Google's redirect does. */
async function connectGmail() {
  const { authorizeUrl } = await post<{ authorizeUrl: string }>("/api/integrations/connect-oauth", {
    id: "catalog:gmail",
    clientId: google.client.id,
    clientSecret: google.client.secret,
  });
  const x = await google.approve(authorizeUrl);
  const back = await fetch(
    `${host.clientUrl}/oauth/callback?code=${x.code}&state=${encodeURIComponent(x.state)}`,
  );
  expect(back.status).toBe(200);
  return new URL(authorizeUrl);
}

const READ_CALLS = [
  { canUseTool: { tool_name: "mcp__gmail__search_threads", input: { query: "salary" } } },
  { mcp: { server: "gmail", tool: "search_threads", args: { query: "salary" } } },
  { canUseTool: { tool_name: "mcp__gmail__get_thread", input: { thread_id: "t1" } } },
  { mcp: { server: "gmail", tool: "get_thread", args: { thread_id: "t1" } } },
  { result: "Read it." },
];

async function openChat(mode: "standard" | "double_loop" = "standard") {
  const id = host.createBot("Mail", "Reads the owner's mail");
  if (mode === "double_loop") setChatMode(host.dataRoot, id, "double_loop");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

describe("connecting Gmail", () => {
  test("Connect sends the owner to Google's consent page for offline access, and the callback connects it with the read tools on Auto", async () => {
    const before = await card();
    expect(before).toMatchObject({ state: "disconnected", transport: { type: "builtin" } });

    const url = await connectGmail();
    expect(url.origin + url.pathname).toBe(google.endpoints.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(`${host.clientUrl}/oauth/callback`);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");

    const after = await card();
    expect(after.state).toBe("connected");
    expect(after.id).toBe("catalog:gmail");
    const READ = ["get_thread", "search_threads"];
    expect(
      after.tools
        .filter((t) => READ.includes(t.name))
        .map((t) => [t.name, t.policy, t.readOnly, t.locked]),
    ).toEqual([
      ["get_thread", "auto", true, false],
      ["search_threads", "auto", true, false],
    ]);
    expect(google.requests.filter((r) => r.kind === "token")).toHaveLength(1);
  });

  test("Disconnect takes Gmail out of the next session", async () => {
    await connectGmail();
    await post("/api/integrations/disconnect", { id: "catalog:gmail" });
    expect((await card()).state).toBe("disconnected");

    await openChat();
    host.loopScript({ steps: [{ result: "hi" }] });
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.launches().length === 1);
    expect(google.gmail()).toEqual([]);
    expect(host.permissionResults()).toEqual([]);
  });
});

describe("reading mail in a chat", () => {
  test("the CLI calls the in-process Gmail tools and gets wrapped plain text; Google saw the requests with the bearer token", async () => {
    await connectGmail();
    const id = await openChat();
    host.loopScript({ match: "check my mail", steps: READ_CALLS });
    expect((await host.ui("/api/send", { text: "check my mail" })).status).toBe(200);
    await host.until(() => host.loopCalls().length === 2);
    await host.until(() => !host.server.isWorking(id));

    expect(host.permissionResults().map((p) => [p.tool_name, p.response?.behavior])).toEqual([
      ["mcp__gmail__search_threads", "allow"],
      ["mcp__gmail__get_thread", "allow"],
    ]);
    const [search, thread] = host.toolResults();
    expect(search).toMatch(/^<<<EMAIL_CONTENT nonce=[0-9a-f]{16} source=gmail>>>/);
    expect(search).toContain(`Subject: ${SECRET_SUBJECT}`);
    expect(thread).toContain(`From: Anna <${SECRET_ADDRESS}>`);
    expect(thread).toContain(SECRET_BODY);
    expect(thread).toContain("Thanks!");
    expect(thread).not.toContain("<p>");

    const [list, one, full] = google.gmail();
    expect(list).toMatchObject({ path: "/gmail/v1/users/me/threads", query: { q: ["salary"] } });
    expect(one).toMatchObject({ query: { format: ["metadata"] } });
    expect(full).toMatchObject({
      path: "/gmail/v1/users/me/threads/t1",
      query: { format: ["full"] },
    });
    for (const r of google.gmail()) {
      expect(r.authorized).toBe(true);
      expect(r.authorization).toStartWith("Bearer ya29.");
    }
  });

  test("the CLI's MCP config file never holds a gmail entry or the token", async () => {
    await connectGmail();
    await openChat();
    host.loopScript({ steps: READ_CALLS });
    expect((await host.ui("/api/send", { text: "check my mail" })).status).toBe(200);
    await host.until(() => host.loopCalls().length === 2);

    const launch = defined(host.launches()[0]);
    expect(Object.keys(launch.mcpServers)).not.toContain("gmail");
    expect(JSON.stringify(launch)).not.toContain("ya29");
  });

  test("a tool switched off is denied for the CLI", async () => {
    await connectGmail();
    await post("/api/integrations/set-policy", {
      id: "catalog:gmail",
      tool: "get_thread",
      policy: "off",
    });
    await openChat();
    host.loopScript({ steps: READ_CALLS.slice(2, 3).concat({ result: "No." }) });
    expect((await host.ui("/api/send", { text: "read it" })).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]?.response?.behavior).toBe("deny");
    expect(host.loopCalls()).toEqual([]);
  });

  test("a tool on Ask raises an approval card, and the owner's allow lets the call through", async () => {
    await connectGmail();
    await post("/api/integrations/set-policy", {
      id: "catalog:gmail",
      tool: "search_threads",
      policy: "ask",
    });
    const page = await watchEvents(host);
    try {
      await openChat();
      host.loopScript({ steps: READ_CALLS.slice(0, 2).concat({ result: "Done." }) });
      expect((await host.ui("/api/send", { text: "search" })).status).toBe(200);
      await host.until(() => page.events().some((e) => e.type === "approve"));
      const approval = defined(page.events().find((e) => e.type === "approve")) as unknown as {
        id: string;
        tool: string;
        actions: { id: string }[];
      };
      expect(approval.tool).toBe("mcp__gmail__search_threads");
      expect(approval.actions.map((a) => a.id)).toEqual(["allow", "allow_always", "deny"]);
      expect(host.loopCalls()).toEqual([]);

      expect((await host.ui("/api/answer", { id: approval.id, value: "allow" })).status).toBe(200);
      await host.until(() => host.loopCalls().length === 1);
      expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain(SECRET_SUBJECT);
    } finally {
      page.stop();
    }
  });
});

describe("reading mail in a double-loop chat", () => {
  test("the front hosts the server, the worker is given its tools and a background agent's call is allowed and answered", async () => {
    await connectGmail();
    const id = await openChat("double_loop");
    host.loopScript({
      match: "dig through my mail",
      steps: [
        {
          canUseTool: {
            tool_name: "mcp__gmail__search_threads",
            input: { query: "salary" },
            agent_id: "agent-1",
          },
        },
        { mcp: { server: "gmail", tool: "search_threads", args: { query: "salary" } } },
        { result: "Found it." },
      ],
    });
    expect((await host.ui("/api/send", { text: "dig through my mail" })).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    await host.until(() => !host.server.isWorking(id));

    expect(host.permissionResults()).toMatchObject([
      {
        tool_name: "mcp__gmail__search_threads",
        agent_id: "agent-1",
        response: { behavior: "allow" },
      },
    ]);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain(SECRET_SUBJECT);

    const launch = defined(host.launches()[0]);
    const worker = (launch.agents as Record<string, { tools: string[] }>).worker;
    expect(worker?.tools).toContain("mcp__gmail");
    expect(Object.keys(launch.mcpServers)).not.toContain("gmail");
    expect(Object.keys(launch.mcpServers)).not.toContain("mcp__gmail");
  });
});

describe("the host log", () => {
  test("holds no token, client secret, subject, body or address after connecting and reading", async () => {
    await connectGmail();
    const id = await openChat();
    host.loopScript({ steps: READ_CALLS });
    expect((await host.ui("/api/send", { text: "check my mail" })).status).toBe(200);
    await host.until(() => host.loopCalls().length === 2);
    await host.until(() => !host.server.isWorking(id));

    const lines = logged.join("\n");
    expect(logged.filter((l) => l.startsWith("[gmail]"))).toEqual([
      "[gmail] threads.list -> 200",
      "[gmail] threads.get t1 -> 200",
      "[gmail] threads.get t1 -> 200",
    ]);
    for (const secret of [
      "ya29",
      "fake-refresh",
      google.client.secret,
      SECRET_SUBJECT,
      SECRET_BODY,
      SECRET_ADDRESS,
    ])
      expect(lines).not.toContain(secret);
  });
});
