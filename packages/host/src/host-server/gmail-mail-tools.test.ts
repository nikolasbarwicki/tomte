import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Built-in Gmail's drafts, labels, trash and attachments on a whole host: the fake Claude CLI calls each in-process `gmail` tool the
// way the real CLI does, and the assertions are what the fake Gmail was asked and what its mailbox holds afterwards.
import { botFilesPath, setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

const SECRET_SUBJECT = "Contract for Anna";
const SECRET_BODY = "Please keep the figure 71,000 EUR private";
const SECRET_ADDRESS = "anna@example.test";

let host: HandoffHost;
let google: FakeGoogle;
let logged: string[];
let restoreLogs: () => void;

beforeEach(async () => {
  google = fakeGoogle();
  google.thread("t1", [
    {
      id: "m1",
      from: `Anna <${SECRET_ADDRESS}>`,
      subject: "Invoice question",
      messageId: "<m1@mail.example>",
      text: "Where is the invoice?",
    },
    {
      id: "m2",
      from: `Boris <boris@example.test>`,
      subject: "Re: Invoice question",
      messageId: "<m2@mail.example>",
      references: "<m1@mail.example>",
      text: "Attached again.",
    },
  ]);
  google.thread("t2", [
    {
      id: "a1",
      from: "Shop <shop@example.test>",
      subject: "Your documents",
      text: "See the files.",
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", data: "A".repeat(25_000) },
        {
          filename: "scan.pdf",
          mimeType: "application/pdf",
          data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 1]),
        },
        { filename: "../../evil.sh", mimeType: "application/x-sh", data: "echo hi" },
      ],
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
  tools: {
    name: string;
    policy: string;
    readOnly: boolean;
    destructive: boolean;
    locked: boolean;
  }[];
};

const post = async <T>(path: string, body: object) => {
  const res = await host.ui(path, body);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const card = async () =>
  defined((await post<Card[]>("/api/integrations/list", {})).find((i) => i.catalogId === "gmail"));

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
}

const ASK_TOOLS = ["create_draft", "update_draft", "modify_labels", "trash_thread"];

/** Connects Gmail, switches the Ask tools to Auto so a script can call them without an owner, and opens a chat. */
async function setUp(mode: "standard" | "background_tasks" = "standard") {
  await connectGmail();
  for (const tool of ASK_TOOLS)
    await post("/api/integrations/set-policy", { id: "catalog:gmail", tool, policy: "auto" });
  const id = host.createBot("Mail", "Handles the owner's mail");
  if (mode === "background_tasks") setChatMode(host.dataRoot, id, "background_tasks");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

type Call = { tool: string; args: Record<string, unknown> };

/** One message to the bot whose reply is these tool calls, in order; returns what each answered. */
async function callTools(botId: string, calls: Call[], agentId?: string) {
  host.loopScript({
    steps: [
      ...calls.flatMap((c) => [
        {
          canUseTool: {
            tool_name: `mcp__gmail__${c.tool}`,
            input: c.args,
            ...(agentId && { agent_id: agentId }),
          },
        },
        { mcp: { server: "gmail", tool: c.tool, args: c.args } },
      ]),
      { result: "Done." },
    ],
  });
  expect((await host.ui("/api/send", { text: "do the mail work" })).status).toBe(200);
  await host.until(() => host.loopCalls().length === calls.length);
  await host.until(() => !host.server.isWorking(botId));
  return host.loopCalls().map((c) => ({
    text: defined(c.result)
      .content.map((x) => x.text)
      .join("\n"),
    isError: c.result?.isError === true,
  }));
}

/** The raw RFC 2822 text of the draft the host saved, with its base64 body decoded. */
function draftText(mime: string) {
  const [head = "", body = ""] = mime.split("\r\n\r\n");
  return {
    head: head.replace(/\r\n[ \t]+/g, " "),
    body: Buffer.from(body, "base64").toString("utf8"),
  };
}

describe("a fresh connection", () => {
  test("lists every tool with the spec's default policy and annotations", async () => {
    await connectGmail();
    expect(
      Object.fromEntries(
        (await card()).tools.map((t) => [t.name, [t.policy, t.readOnly, t.destructive, t.locked]]),
      ),
    ).toMatchObject({
      search_threads: ["auto", true, false, false],
      get_thread: ["auto", true, false, false],
      list_labels: ["auto", true, false, false],
      list_drafts: ["auto", true, false, false],
      get_attachment: ["auto", true, false, false],
      create_draft: ["ask", false, false, false],
      update_draft: ["ask", false, false, false],
      modify_labels: ["ask", false, false, false],
      trash_thread: ["ask", false, true, false],
    });
  });

  test("a draft on Ask raises an approval card, and nothing reaches Gmail until the owner allows it", async () => {
    await connectGmail();
    const id = host.createBot("Mail", "Handles the owner's mail");
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    const page = await watchEvents(host);
    try {
      const args = { to: [SECRET_ADDRESS], subject: "Hello", body: "Hi Anna" };
      host.loopScript({
        steps: [
          { canUseTool: { tool_name: "mcp__gmail__create_draft", input: args } },
          { mcp: { server: "gmail", tool: "create_draft", args } },
          { result: "Done." },
        ],
      });
      expect((await host.ui("/api/send", { text: "draft it" })).status).toBe(200);
      await host.until(() => page.events().some((e) => e.type === "approve"));
      const approval = defined(page.events().find((e) => e.type === "approve")) as unknown as {
        id: string;
        tool: string;
      };
      expect(approval.tool).toBe("mcp__gmail__create_draft");
      expect(google.gmail()).toEqual([]);

      expect((await host.ui("/api/answer", { id: approval.id, value: "allow" })).status).toBe(200);
      await host.until(() => host.loopCalls().length === 1);
      expect(google.drafts()).toHaveLength(1);
    } finally {
      page.stop();
    }
  });

  test("trash on Ask is denied when switched Off, even for a chat that approves everything", async () => {
    await connectGmail();
    await post("/api/integrations/set-policy", {
      id: "catalog:gmail",
      tool: "trash_thread",
      policy: "off",
    });
    const id = host.createBot("Mail", "Handles the owner's mail");
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    host.loopScript({
      steps: [
        { canUseTool: { tool_name: "mcp__gmail__trash_thread", input: { thread_id: "t1" } } },
        { result: "No." },
      ],
    });
    expect((await host.ui("/api/send", { text: "clean up" })).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]?.response?.behavior).toBe("deny");
    expect(google.trashed()).toEqual([]);
  });
});

describe("labels", () => {
  test("list_labels names the system and the owner's labels with their ids", async () => {
    const id = await setUp();
    const [labels] = await callTools(id, [{ tool: "list_labels", args: {} }]);
    expect(labels?.text).toContain("- INBOX | id=INBOX | system");
    expect(labels?.text).toContain("- Receipts | id=Label_1 | user");
    expect(google.gmail().map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /gmail/v1/users/me/labels",
    ]);
  });

  test("modify_labels resolves names to ids, and archive is removing INBOX; a message can be changed alone", async () => {
    const id = await setUp();
    const results = await callTools(id, [
      {
        tool: "modify_labels",
        args: { thread_id: "t1", add_labels: ["receipts"], remove_labels: ["INBOX"] },
      },
      { tool: "modify_labels", args: { message_id: "m2", remove_labels: ["UNREAD"] } },
    ]);
    expect(results.map((r) => r.isError)).toEqual([false, false]);
    expect(google.labelChanges()).toEqual([
      { kind: "thread", id: "t1", add: ["Label_1"], remove: ["INBOX"] },
      { kind: "message", id: "m2", add: [], remove: ["UNREAD"] },
    ]);
    const modify = google.gmail().filter((r) => r.method === "POST");
    expect(modify.map((r) => r.path)).toEqual([
      "/gmail/v1/users/me/threads/t1/modify",
      "/gmail/v1/users/me/messages/m2/modify",
    ]);
    expect(modify[0]?.body).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] });
  });

  test("modify_labels refuses an unknown label, a call that names no target and the trash label, without changing anything", async () => {
    const id = await setUp();
    const results = await callTools(id, [
      { tool: "modify_labels", args: { thread_id: "t1", add_labels: ["Nonexistent"] } },
      { tool: "modify_labels", args: { add_labels: ["Receipts"] } },
      { tool: "modify_labels", args: { thread_id: "t1", add_labels: ["TRASH"] } },
      { tool: "modify_labels", args: { thread_id: "t1" } },
    ]);
    expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(results[0]?.text).toContain('no label named "Nonexistent"');
    expect(results[2]?.text).toContain("trash_thread");
    expect(google.labelChanges()).toEqual([]);
  });

  test("trash_thread moves the thread to the trash; there is no permanent delete", async () => {
    await connectGmail();
    expect((await card()).tools.map((t) => t.name)).not.toContain("delete_thread");
    const id = await setUp();
    const [trashed] = await callTools(id, [{ tool: "trash_thread", args: { thread_id: "t1" } }]);
    expect(trashed?.isError).toBe(false);
    expect(google.trashed()).toEqual(["t1"]);
    expect(google.gmail().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /gmail/v1/users/me/threads/t1/trash",
    ]);
  });
});

describe("drafts", () => {
  test("create_draft saves a plain-text message that Gmail can send as it is, and sends nothing", async () => {
    const id = await setUp();
    const [made] = await callTools(id, [
      {
        tool: "create_draft",
        args: {
          to: [`Anna Kowalska <${SECRET_ADDRESS}>`, "boris@example.test"],
          cc: ["carol@example.test"],
          subject: "Zażółć gęślą jaźń — plan",
          body: "Line one\nLine two — żółw",
        },
      },
    ]);
    expect(made?.isError).toBe(false);
    expect(made?.text).toContain("Nothing was sent");
    const [draft] = google.drafts();
    const { head, body } = draftText(defined(draft).mime);
    expect(head).toContain(`To: "Anna Kowalska" <${SECRET_ADDRESS}>, boris@example.test`);
    expect(head).toContain("Cc: carol@example.test");
    expect(head).not.toContain("Bcc");
    const encoded = /^Subject: (.*)$/m.exec(head)?.[1] ?? "";
    const decoded = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map((m) => Buffer.from(m[1] ?? "", "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Zażółć gęślą jaźń — plan");
    expect(body).toBe("Line one\r\nLine two — żółw");
    expect(google.gmail().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /gmail/v1/users/me/drafts",
    ]);
    expect(google.gmail().some((r) => r.path.endsWith("/send"))).toBe(false);
  });

  test("a draft in a thread replies under the latest message: thread id, In-Reply-To, References and a Re: subject", async () => {
    const id = await setUp();
    const [made] = await callTools(id, [
      { tool: "create_draft", args: { to: [SECRET_ADDRESS], body: "Sent now.", thread_id: "t1" } },
    ]);
    expect(made?.text).toContain("thread t1");
    const [draft] = google.drafts();
    expect(draft?.threadId).toBe("t1");
    const { head } = draftText(defined(draft).mime);
    expect(head).toContain("Subject: Re: Invoice question");
    expect(head).toContain("In-Reply-To: <m2@mail.example>");
    expect(head).toContain("References: <m1@mail.example> <m2@mail.example>");
    expect(google.gmail().find((r) => r.method === "POST")).toMatchObject({
      body: { message: { threadId: "t1" } },
    });
  });

  test("a message with no subject outside a thread, a reply in an empty thread and a bad address are tool errors that save nothing", async () => {
    const id = await setUp();
    const results = await callTools(id, [
      { tool: "create_draft", args: { to: [SECRET_ADDRESS], body: "x" } },
      { tool: "create_draft", args: { to: ["not an address"], subject: "s", body: "x" } },
      {
        tool: "create_draft",
        args: { to: [`${SECRET_ADDRESS}\r\nBcc: spy@example.test`], subject: "s", body: "x" },
      },
      {
        tool: "create_draft",
        args: { to: [SECRET_ADDRESS], subject: "bad\r\nBcc: spy@example.test", body: "x" },
      },
    ]);
    expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(results[0]?.text).toContain("subject");
    expect(google.drafts()).toEqual([]);
  });

  test("list_drafts shows drafts wrapped as untrusted mail, and update_draft rewrites one in place", async () => {
    google.draft({
      id: "d1",
      threadId: "t1",
      mime: `To: ${SECRET_ADDRESS}\r\nSubject: Seeded draft\r\n\r\nv0`,
    });
    const id = await setUp();
    const [list, , update] = await callTools(id, [
      { tool: "list_drafts", args: {} },
      { tool: "create_draft", args: { to: [SECRET_ADDRESS], subject: "First", body: "v1" } },
      {
        tool: "update_draft",
        args: { draft_id: "r-draft-1", to: [SECRET_ADDRESS], subject: "Second", body: "v2" },
      },
    ]);
    expect(list?.text).toMatch(/^<<<EMAIL_CONTENT nonce=[0-9a-f]{16} source=gmail>>>/);
    expect(list?.text).toContain("Draft d1 | message d1-message | thread t1");
    expect(list?.text).toContain("Subject: Seeded draft");
    expect(update).toMatchObject({
      isError: false,
      text: "Draft r-draft-1 updated. Nothing was sent.",
    });

    const rewritten = defined(google.drafts().find((d) => d.id === "r-draft-1"));
    expect(draftText(rewritten.mime).head).toContain("Subject: Second");
    expect(draftText(rewritten.mime).body).toBe("v2");
    expect(google.drafts()).toHaveLength(2);
    const put = defined(google.gmail().find((r) => r.method === "PUT"));
    expect(put.path).toBe("/gmail/v1/users/me/drafts/r-draft-1");
  });

  test("a second page of drafts is offered with its token", async () => {
    for (let i = 0; i < 3; i++)
      google.draft({ id: `d${i}`, mime: `To: ${SECRET_ADDRESS}\r\nSubject: S${i}\r\n\r\nx` });
    const id = await setUp();
    const [page] = await callTools(id, [{ tool: "list_drafts", args: { max_results: 2 } }]);
    expect(page?.text).toContain("next_page_token: drafts-2");
  });
});

describe("attachments", () => {
  test("get_thread lists each attachment's name, type, size and part id inside the mail wrapper", async () => {
    const id = await setUp();
    const [thread] = await callTools(id, [{ tool: "get_thread", args: { thread_id: "t2" } }]);
    const text = defined(thread).text;
    expect(text).toMatch(/^<<<EMAIL_CONTENT /);
    expect(text).toContain("Attachments:");
    expect(text).toContain("- notes.txt (text/plain, 24 KB) part_id=1");
    expect(text).toContain("- scan.pdf (application/pdf, 7 B) part_id=2");
    expect(text.indexOf("Attachments:")).toBeLessThan(text.indexOf("<<<END_EMAIL_CONTENT"));
  });

  test("a text attachment comes back inline, cut at the cap with a marker, and nothing is saved", async () => {
    const id = await setUp();
    const [notes] = await callTools(id, [
      { tool: "get_attachment", args: { message_id: "a1", part_id: "1" } },
    ]);
    const text = defined(notes).text;
    expect(text).toMatch(/^<<<EMAIL_CONTENT nonce=[0-9a-f]{16} source=gmail>>>/);
    expect(text).toContain("A".repeat(20_000));
    expect(text).not.toContain("A".repeat(20_001));
    expect(text).toContain("5000 more characters not shown");
    expect(existsSync(join(botFilesPath(host.dataRoot, id), "gmail-attachments"))).toBe(false);
  });

  test("a binary attachment is saved in the bot's files folder and its path returned; a hostile file name stays inside the folder", async () => {
    const id = await setUp();
    const results = await callTools(id, [
      { tool: "get_attachment", args: { message_id: "a1", part_id: "2" } },
      { tool: "get_attachment", args: { message_id: "a1", part_id: "2" } },
      { tool: "get_attachment", args: { message_id: "a1", part_id: "3" } },
    ]);
    const dir = join(botFilesPath(host.dataRoot, id), "gmail-attachments");
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    expect(results[0]?.text).toContain(join(dir, "scan.pdf"));
    expect(results[1]?.text).toContain(join(dir, "scan 2.pdf"));
    expect([...readFileSync(join(dir, "scan.pdf"))]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 255, 1]);
    expect(readdirSync(dir).sort()).toEqual(["_.._evil.sh", "scan 2.pdf", "scan.pdf"]);
    expect(results[2]?.text).toContain(join(dir, "_.._evil.sh"));
    expect(readFileSync(join(dir, "_.._evil.sh"), "utf8")).toBe("echo hi");
    expect(existsSync(join(botFilesPath(host.dataRoot, id), "..", "evil.sh"))).toBe(false);
  });

  test("a part that is not an attachment is a tool error", async () => {
    const id = await setUp();
    const [missing] = await callTools(id, [
      { tool: "get_attachment", args: { message_id: "a1", part_id: "9" } },
    ]);
    expect(missing?.isError).toBe(true);
    expect(missing?.text).toContain("part_id 9");
  });

  test("a background-tasks bot's background task saves into the same files folder", async () => {
    const id = await setUp("background_tasks");
    const [saved] = await callTools(
      id,
      [{ tool: "get_attachment", args: { message_id: "a1", part_id: "2" } }],
      "agent-1",
    );
    expect(host.permissionResults()[0]?.agent_id).toBe("agent-1");
    const dir = join(botFilesPath(host.dataRoot, id), "gmail-attachments");
    expect(saved?.text).toContain(join(dir, "scan.pdf"));
    expect(existsSync(join(dir, "scan.pdf"))).toBe(true);
  });
});

describe("API errors", () => {
  test("a 404 reaches the bot as a tool error that names no URL or token", async () => {
    const id = await setUp();
    const [gone] = await callTools(id, [{ tool: "trash_thread", args: { thread_id: "nope" } }]);
    expect(gone?.isError).toBe(true);
    expect(gone?.text).toContain("404");
    expect(gone?.text).not.toMatch(/https?:|127\.0\.0\.1|ya29/);
  });

  test("a 429 is one tool error, with Google's URL and token-like text removed, and the call is not retried", async () => {
    const id = await setUp();
    google.respond(
      "POST /gmail/v1/users/me/threads/t1/modify",
      {
        status: 429,
        body: {
          error: {
            code: 429,
            message: `Rate Limit Exceeded, see https://developers.google.com/gmail/quotas?key=ya29.leaked-access-token-123456789012345678901234567890`,
            errors: [{ reason: "rateLimitExceeded" }],
          },
        },
      },
      5,
    );
    const [limited] = await callTools(id, [
      { tool: "modify_labels", args: { thread_id: "t1", remove_labels: ["INBOX"] } },
    ]);
    expect(limited?.isError).toBe(true);
    expect(limited?.text).toContain("429");
    expect(limited?.text).toContain("Rate Limit Exceeded");
    expect(limited?.text).not.toMatch(/https?:|ya29|leaked/);
    expect(google.gmail().filter((r) => r.path.endsWith("/modify"))).toHaveLength(1);
    expect(google.labelChanges()).toEqual([]);
  });
});

describe("the host log", () => {
  test("names the operations and ids, never a subject, body, address or token", async () => {
    const id = await setUp();
    await callTools(id, [
      {
        tool: "create_draft",
        args: { to: [SECRET_ADDRESS], subject: SECRET_SUBJECT, body: SECRET_BODY },
      },
      { tool: "get_attachment", args: { message_id: "a1", part_id: "2" } },
    ]);
    const lines = logged.join("\n");
    expect(logged.filter((l) => l.startsWith("[gmail]"))).toEqual([
      "[gmail] drafts.create -> 200",
      "[gmail] messages.get a1 -> 200",
      "[gmail] attachments.get a1 -> 200",
    ]);
    for (const secret of [
      "ya29",
      google.client.secret,
      SECRET_SUBJECT,
      SECRET_BODY,
      SECRET_ADDRESS,
      "scan.pdf",
    ])
      expect(lines).not.toContain(secret);
  });
});
