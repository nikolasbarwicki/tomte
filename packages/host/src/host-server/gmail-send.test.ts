import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Sending mail with the built-in Gmail server on a whole host: the fake CLI asks permission and then calls the in-process `gmail`
// server, the fake Google records what reaches Gmail, and the fake Bot API stands in for a linked phone. `send_message` is locked,
// so every send waits for the owner, whatever else the host or the bot has allowed.
import { ChannelLinkCodeResponse } from "@tomte/contract/api";

import { allowTool, setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { fakeTelegram, type FakeCall, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const SEND = "mcp__gmail__send_message";
const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const TOO_LONG = "Input too long to show here. Open the web UI to approve.";
const DAY = 24 * 60 * 60_000;

/** A reply in thread `t1`: a named address, a display name outside ASCII, a bare one, copy, blind copy and a Polish subject. */
const REPLY = {
  to: ["Anna <anna@example.test>", "Zażółć Gęślą <zg@example.test>", "bob@example.test"],
  cc: ["boss@example.test"],
  bcc: ["audit@example.test"],
  subject: "Re: Podwyżka dla Anny – dziękuję",
  body: "Dzięki, Anno!\n\nPozdrawiam,\nMe",
  thread_id: "t1",
};
const OTHER = { to: ["eve@example.test"], subject: "Hello", body: "A different message." };

let google: FakeGoogle;
let tg: FakeTelegram;
let host: HandoffHost;
let page: EventsWatch;

beforeEach(async () => {
  google = fakeGoogle();
  google.thread("t1", [
    {
      id: "m1",
      from: "Anna <anna@example.test>",
      subject: "Podwyżka dla Anny",
      text: "Prośba o podwyżkę",
      messageId: "<m1@mail.example>",
    },
    {
      id: "m2",
      from: "Me <me@example.test>",
      subject: "Re: Podwyżka dla Anny",
      text: "Zobaczymy",
      messageId: "<m2@mail.example>",
      references: "<m1@mail.example>",
    },
  ]);
  tg = fakeTelegram();
  host = await startHandoffHost([], undefined, undefined, {
    google: google.endpoints,
    telegram: { baseUrl: tg.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    cards: { retryMs: 30 },
  });
  page = await watchEvents(host);
});
afterEach(async () => {
  page.stop();
  await host.stop();
  await tg.stop();
  await google.stop();
});

const post = async <T>(path: string, body: object) => {
  const res = await host.ui(path, body);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

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
}

const setPolicy = (tool: string, policy: string) =>
  host.ui("/api/integrations/set-policy", { id: "catalog:gmail", tool, policy });
const gmailTools = async () =>
  defined(
    (
      await post<
        { catalogId: string | null; tools: { name: string; policy: string; locked: boolean }[] }[]
      >("/api/integrations/list", {})
    ).find((i) => i.catalogId === "gmail"),
  ).tools;

/** The tool's permission request, then its call with the same arguments, as the real CLI makes them for an allowed call. */
const sends = (input: Record<string, unknown>, result = "Sent.") => [
  { canUseTool: { tool_name: SEND, input } },
  { mcp: { server: "gmail", tool: "send_message", args: input } },
  { result },
];
/** Only the permission request: for a call the owner is going to deny, which the CLI then never makes. */
const asks = (input: Record<string, unknown>) => [
  { canUseTool: { tool_name: SEND, input } },
  { result: "Denied." },
];

async function openChat(mode: "standard" | "double_loop" = "standard") {
  const id = host.createBot("Mail", "Writes the owner's mail");
  if (mode === "double_loop") setChatMode(host.dataRoot, id, "double_loop");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

type Approval = {
  id: string;
  tool: string;
  reason: string;
  input: unknown;
  actions: { id: string; label: string }[];
};
/** The approval cards the page was shown, each with its canonical input read back as the object the bot passed. */
const approvals = () =>
  page
    .events()
    .filter((e) => e.type === "approve")
    .map((e) => ({ ...e, input: JSON.parse(String(e.input)) as unknown })) as unknown as Approval[];
const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });
/** Sends a message and returns the approval card it makes the bot raise. */
async function asked(text: string) {
  const before = approvals().length;
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => approvals().length > before);
  return defined(approvals()[before]);
}
const idle = (botId: string) => host.until(() => !host.server.isWorking(botId));
const allowances = async (botId: string) =>
  (
    await post<{ allowances: { tool: string }[] }>("/api/bots/allowances", { botId })
  ).allowances.map((a) => a.tool);

/** The mail Google was asked to send, with the headers decoded (unfolded, RFC 2047 words read) and the body as text. */
const sent = () =>
  google.sent().map((s) => {
    const [head = "", ...rest] = s.mime.split("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      headers[line.slice(0, i).toLowerCase()] = line
        .slice(i + 1)
        .trim()
        .replace(/(=\?UTF-8\?B\?[^?]*\?=) (?==\?UTF-8\?B\?)/g, "$1")
        .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b: string) => Buffer.from(b, "base64").toString());
    }
    const body = Buffer.from(rest.join("\r\n\r\n"), "base64").toString().replace(/\r\n/g, "\n");
    return { via: s.via, threadId: s.threadId, draftId: s.draftId, headers, body };
  });
const DRAFT = { id: "r-9", mime: "To: eve@example.test\r\nSubject: Draft\r\n\r\nWords" };
/** What the owner is shown of `DRAFT`, and what the approved input pins. */
const DRAFT_SHOWN = {
  to: "eve@example.test",
  subject: "Draft",
  body: "Words",
  thread_id: "r-9-thread",
};
/** A draft in Gmail's words: a quoted display name, a copy, a Polish subject (an RFC 2047 word in the headers) and a body. */
const b64 = (text: string) => Buffer.from(text).toString("base64");
const PL_DRAFT = {
  id: "r-10",
  mime: [
    'To: "Anna" <anna@example.test>',
    "Cc: boss@example.test",
    `Subject: =?UTF-8?B?${b64("Podwyżka – dziękuję")}?=`,
    "Content-Transfer-Encoding: base64",
    "",
    b64("Dzięki, Anno!\r\n\r\nPozdrawiam"),
  ].join("\r\n"),
};
const PL_SHOWN = {
  to: '"Anna" <anna@example.test>',
  cc: "boss@example.test",
  subject: "Podwyżka – dziękuję",
  body: "Dzięki, Anno!\n\nPozdrawiam",
  thread_id: "r-10-thread",
};

describe("the Integrations view", () => {
  test("shows send_message as locked on Ask, refuses Auto with 400 and accepts Ask and Off", async () => {
    await connectGmail();
    const find = async () => defined((await gmailTools()).find((t) => t.name === "send_message"));

    expect(await find()).toMatchObject({ policy: "ask", locked: true });
    expect((await gmailTools()).filter((t) => t.locked).map((t) => t.name)).toEqual([
      "send_message",
    ]);

    expect((await setPolicy("send_message", "auto")).status).toBe(400);
    expect(await find()).toMatchObject({ policy: "ask", locked: true });
    expect((await setPolicy("send_message", "off")).status).toBe(200);
    expect(await find()).toMatchObject({ policy: "off", locked: true });
    expect((await setPolicy("send_message", "ask")).status).toBe(200);
    expect(await find()).toMatchObject({ policy: "ask", locked: true });
  });

  test("a send switched Off is denied with no card and sends nothing", async () => {
    await connectGmail();
    expect((await setPolicy("send_message", "off")).status).toBe(200);
    await openChat();
    host.loopScript({
      steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "No." }],
    });
    expect((await host.ui("/api/send", { text: "send it" })).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);

    expect(host.permissionResults()[0]?.response).toMatchObject({ behavior: "deny" });
    expect(approvals()).toEqual([]);
    expect(sent()).toEqual([]);
  });
});

describe("a send in a chat", () => {
  test("asks with Allow and Deny only though the host approves everything and the bot always allows it; Allow sends exactly the shown input once", async () => {
    await connectGmail();
    const botId = await openChat();
    allowTool(host.db, botId, SEND, Date.now());
    host.loopScript({ match: "send it", steps: sends(REPLY) });
    expect((await host.ui("/api/send", { text: "send it" })).status).toBe(200);
    await host.until(() => approvals().length === 1);

    const card = defined(approvals()[0]);
    expect(card.tool).toBe(SEND);
    expect(card.actions).toEqual([
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ]);
    expect(card.input).toEqual(REPLY);
    expect(sent()).toEqual([]);
    expect(host.permissionResults()).toEqual([]);

    expect((await answer(card.id, "allow_always")).status).toBe(404);
    expect(await allowances(botId)).toEqual([SEND]);
    expect(sent()).toEqual([]);

    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    expect(host.permissionResults()[0]?.response).toMatchObject({
      behavior: "allow",
      updatedInput: REPLY,
    });

    expect(sent()).toHaveLength(1);
    const [mail] = sent();
    expect(mail?.threadId).toBe("t1");
    expect(mail?.headers).toMatchObject({
      to: '"Anna" <anna@example.test>, Zażółć Gęślą <zg@example.test>, bob@example.test',
      cc: "boss@example.test",
      bcc: "audit@example.test",
      subject: REPLY.subject,
      "in-reply-to": "<m2@mail.example>",
      references: "<m1@mail.example> <m2@mail.example>",
      "content-type": 'text/plain; charset="UTF-8"',
    });
    expect(mail?.body).toBe(REPLY.body);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toBe("Sent message sent-1 in thread t1.");
    for (const r of google.gmail()) expect(r.authorized).toBe(true);
  });

  test("Deny sends nothing and tells the bot the owner declined", async () => {
    await connectGmail();
    await openChat();
    host.loopScript({
      steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "Ok." }],
    });
    expect((await host.ui("/api/send", { text: "send it" })).status).toBe(200);
    await host.until(() => approvals().length === 1);
    expect((await answer(defined(approvals()[0]).id, "deny")).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);

    expect(host.permissionResults()[0]?.response).toMatchObject({ behavior: "deny" });
    expect(sent()).toEqual([]);
    expect(google.gmail().filter((r) => r.method === "POST")).toEqual([]);
  });

  test("an allow covers one call: the same send and a different one both ask again", async () => {
    await connectGmail();
    const botId = await openChat();
    host.loopScript(
      { match: "first", steps: sends(REPLY) },
      { match: "second", steps: asks(OTHER) },
      { match: "third", steps: asks(REPLY) },
    );

    const first = await asked("first");
    expect((await answer(first.id, "allow")).status).toBe(200);
    await host.until(() => sent().length === 1);
    await idle(botId);

    const second = await asked("second");
    expect(second.input).toEqual(OTHER);
    expect(sent()).toHaveLength(1);
    expect((await answer(second.id, "deny")).status).toBe(200);
    await idle(botId);

    const third = await asked("third");
    expect(third.input).toEqual(REPLY);
    expect(sent()).toHaveLength(1);
    expect((await answer(third.id, "deny")).status).toBe(200);
  });

  test("a new message goes out with no thread and no reply headers", async () => {
    await connectGmail();
    await openChat();
    host.loopScript({ steps: sends(OTHER) });

    expect((await answer((await asked("message")).id, "allow")).status).toBe(200);
    await host.until(() => sent().length === 1);

    expect(sent()[0]).toMatchObject({
      via: "messages",
      threadId: undefined,
      headers: { to: "eve@example.test", subject: "Hello" },
      body: OTHER.body,
    });
    expect(sent()[0]?.headers["in-reply-to"]).toBeUndefined();
    expect(sent()[0]?.headers.references).toBeUndefined();
  });

  test("the card of a draft shows its recipients, subject and body, and Allow sends that draft once", async () => {
    await connectGmail();
    google.draft(PL_DRAFT);
    const botId = await openChat();
    allowTool(host.db, botId, SEND, Date.now());
    host.loopScript({ steps: sends({ draft_id: "r-10" }, "Done.") });

    const card = await asked("send the draft");
    expect(card.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
    expect(card.input).toEqual({ draft_id: "r-10", expected: PL_SHOWN });
    expect(sent()).toEqual([]);
    expect(host.permissionResults()).toEqual([]);

    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ via: "drafts", draftId: "r-10" });
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toBe(
      "Sent draft r-10 as message sent-1 in thread sent-thread-1.",
    );
    expect(google.drafts()).toEqual([]);
  });

  test("the owner approves the draft as Gmail holds it, whatever the bot says it contains", async () => {
    await connectGmail();
    google.draft(DRAFT);
    await openChat();
    const forged = { to: "owner@example.test", subject: "Harmless", body: "Nothing to see" };
    host.loopScript({ steps: asks({ draft_id: "r-9", expected: forged }) });

    const card = await asked("send the draft");

    expect(card.input).toEqual({ draft_id: "r-9", expected: DRAFT_SHOWN });
    expect((await answer(card.id, "deny")).status).toBe(200);
    expect(sent()).toEqual([]);
  });

  test("a subject in quoted-printable words is shown as text", async () => {
    await connectGmail();
    google.draft({
      id: "r-11",
      mime: "To: eve@example.test\r\nSubject: =?UTF-8?Q?Zam=C3=B3wienie_=E2=80=93?= =?UTF-8?Q?_ok?=\r\n\r\nHi",
    });
    await openChat();
    host.loopScript({ steps: asks({ draft_id: "r-11" }) });

    const card = await asked("send the draft");

    expect(card.input).toMatchObject({ expected: { subject: "Zamówienie – ok", body: "Hi" } });
    expect((await answer(card.id, "deny")).status).toBe(200);
  });

  test("a draft edited after the owner approved it is not sent", async () => {
    await connectGmail();
    google.draft(DRAFT);
    await openChat();
    host.loopScript({ steps: sends({ draft_id: "r-9" }) });

    const card = await asked("send the draft");
    google.draft({ id: "r-9", mime: "To: spy@example.test\r\nSubject: Draft\r\n\r\nWords" });
    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);

    expect(host.loopCalls()[0]?.result?.isError).toBe(true);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain(
      "changed after the owner approved",
    );
    expect(sent()).toEqual([]);
    expect(google.drafts()).toHaveLength(1);
  });

  test("a draft is refused before any card when it is missing or sent with other fields", async () => {
    await connectGmail();
    google.draft(DRAFT);
    await openChat();
    host.loopScript({
      steps: [
        { canUseTool: { tool_name: SEND, input: { draft_id: "gone" } } },
        { canUseTool: { tool_name: SEND, input: { draft_id: "r-9", body: "and this" } } },
        { result: "Refused." },
      ],
    });
    expect((await host.ui("/api/send", { text: "try" })).status).toBe(200);
    await host.until(() => host.permissionResults().length === 2);

    const [gone, extra] = host.permissionResults();
    expect(gone?.response).toMatchObject({ behavior: "deny" });
    expect(JSON.stringify(gone?.response)).toContain("404");
    expect(extra?.response).toMatchObject({ behavior: "deny" });
    expect(JSON.stringify(extra?.response)).toContain("leave out body");
    expect(approvals()).toEqual([]);
    expect(sent()).toEqual([]);
  });

  test("a call the tool cannot make safely is refused and sends nothing", async () => {
    await connectGmail();
    google.draft(DRAFT);
    await openChat();
    const call = (args: Record<string, unknown>) => ({
      mcp: { server: "gmail", tool: "send_message", args },
    });
    host.loopScript({
      steps: [
        call({ draft_id: "r-9", body: "and also this" }),
        call({ to: ["eve@example.test"], subject: "Hello" }),
        call({ to: ["eve@example.test\r\nBcc: spy@example.test"], subject: "Hi", body: "x" }),
        call({ to: ["eve@example.test"], subject: "Hi\r\nBcc: spy@example.test", body: "x" }),
        call({ to: ["eve@example.test"], subject: "Hi", body: "x", thread_id: "nope" }),
        call({ draft_id: "r-9" }),
        { result: "Refused." },
      ],
    });
    expect((await host.ui("/api/send", { text: "try" })).status).toBe(200);
    await host.until(() => host.loopCalls().length === 6);

    expect(host.loopCalls().map((c) => c.result?.isError)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain("body");
    expect(host.loopCalls()[4]?.result?.content[0]?.text).toContain("404");
    expect(host.loopCalls()[5]?.result?.content[0]?.text).toContain("has not seen this draft");
    expect(sent()).toEqual([]);
  });

  test("an input too long for a card offers Deny only on the phone, and Deny sends nothing", async () => {
    await connectGmail();
    await openChat();
    const long = { ...OTHER, body: "x".repeat(6000) };
    const t = await link();
    host.loopScript({
      steps: [{ canUseTool: { tool_name: SEND, input: long } }, { result: "No." }],
    });
    expect((await host.ui("/api/send", { text: "send it" })).status).toBe(200);
    const c = await t.card(0);

    expect(t.text(c)).toContain(TOO_LONG);
    expect(t.labels(c)).toEqual(["Deny"]);
    expect(await t.press(c, "Deny")).toBe("Answered");
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]?.response).toMatchObject({ behavior: "deny" });
    expect(sent()).toEqual([]);
  });
});

/** Links the owner's phone to the fake Bot API and returns what a test needs to read and press its cards. */
async function link() {
  expect((await host.ui("/api/channels/telegram/token", { token: tg.token })).status).toBe(200);
  await host.until(() => tg.of("getUpdates").length > 0);
  const { code } = ChannelLinkCodeResponse.parse(
    await (await host.ui("/api/channels/link-code", { channel: "telegram" })).json(),
  );
  const handled = (id: number) =>
    host.until(() =>
      tg.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
    );
  await handled(tg.message(owner, code));

  type Keyboard = { text: string; callback_data?: string }[][];
  const cards = () =>
    tg
      .of("sendMessage")
      .filter((c) => c.status === 200 && !String(c.params.text).startsWith("Linked."));
  const buttons = (c: FakeCall) =>
    ((c.params.reply_markup as { inline_keyboard: Keyboard } | undefined)?.inline_keyboard ?? [])
      .flat()
      .filter((b) => b.callback_data !== undefined);
  return {
    cards,
    card: async (n: number) => {
      await host.until(() => cards().length > n);
      return defined(cards()[n], "card");
    },
    text: (c: FakeCall) => String(c.params.text),
    labels: (c: FakeCall) => buttons(c).map((b) => b.text),
    press: async (c: FakeCall, label: string) => {
      const data = defined(buttons(c).find((b) => b.text === label)).callback_data!;
      const before = tg.of("answerCallbackQuery").length;
      await handled(tg.press(owner, data, c.messageId!));
      await host.until(() => tg.of("answerCallbackQuery").length > before);
      return String(tg.of("answerCallbackQuery").at(-1)?.params.text);
    },
    edits: (c: FakeCall) =>
      tg.of("editMessageText").filter((e) => e.params.message_id === c.messageId),
  };
}

describe("a scheduled routine's send", () => {
  type Run = { id: string; status: string };

  async function routine() {
    const planner = host.createBot("Planner");
    const other = host.createBot("Other");
    const created = await post<{ id: string }>("/api/routines/create", {
      botId: planner,
      name: "nightly",
      instruction: "send the Anna reply",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    // Another bot is shown, so the planner has no chat and its run is headless.
    expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
    return created.id;
  }
  const runs = (id: string) => post<Run[]>("/api/routines/runs", { id });
  // The planner is not open, so its runs are not on the page's stream: ask the route.
  const untilRun = async (id: string, status: string) => {
    for (let i = 0; i < 160 && (await runs(id))[0]?.status !== status; i++) await Bun.sleep(25);
    expect((await runs(id))[0]?.status).toBe(status);
  };
  const resumes = (steps: Record<string, unknown>[]) => ({ match: "human-wait-result", steps });

  test("parks the run; Allow on the phone's card, which has no Always allow, resumes it and Gmail gets one send", async () => {
    await connectGmail();
    const t = await link();
    const routineId = await routine();
    host.loopScript(
      {
        match: "send the Anna reply",
        steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "Waiting." }],
      },
      resumes(sends(REPLY, "Sent.")),
    );
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");

    const c = await t.card(0);
    expect(t.text(c)).toContain(`Allow ${SEND}?`);
    expect(t.text(c)).toContain(JSON.stringify(REPLY, null, 2));
    expect(t.labels(c)).toEqual(["Allow", "Deny"]);
    expect(sent()).toEqual([]);

    expect(await t.press(c, "Allow")).toBe("Answered");
    await untilRun(routineId, "succeeded");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.headers.subject).toBe(REPLY.subject);
    expect(sent()[0]?.threadId).toBe("t1");
    expect(await runs(routineId)).toHaveLength(1);
    expect(t.cards()).toHaveLength(1);
  });

  test("Deny resumes the run and nothing is sent", async () => {
    await connectGmail();
    const t = await link();
    const routineId = await routine();
    host.loopScript(
      {
        match: "send the Anna reply",
        steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "Waiting." }],
      },
      resumes([{ result: "Understood." }]),
    );
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");

    expect(await t.press(await t.card(0), "Deny")).toBe("Answered");
    await untilRun(routineId, "succeeded");
    expect(sent()).toEqual([]);
  });

  test("an allow is for the input shown: when the resumed run asks with other input, it parks again and sends nothing", async () => {
    await connectGmail();
    const t = await link();
    const routineId = await routine();
    host.loopScript(
      {
        match: "send the Anna reply",
        steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "Waiting." }],
      },
      resumes([{ canUseTool: { tool_name: SEND, input: OTHER } }, { result: "Waiting again." }]),
    );
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");
    expect(await t.press(await t.card(0), "Allow")).toBe("Answered");

    const second = await t.card(1);
    expect(t.text(second)).toContain(JSON.stringify(OTHER, null, 2));
    expect(t.labels(second)).toEqual(["Allow", "Deny"]);
    await untilRun(routineId, "waiting");
    expect(sent()).toEqual([]);
  });

  test("a draft's card shows its content, and Allow lets the resumed run send that draft once", async () => {
    await connectGmail();
    google.draft(PL_DRAFT);
    const t = await link();
    const routineId = await routine();
    host.loopScript(
      {
        match: "send the Anna reply",
        steps: [
          { canUseTool: { tool_name: SEND, input: { draft_id: "r-10" } } },
          { result: "Waiting." },
        ],
      },
      resumes(sends({ draft_id: "r-10" }, "Sent.")),
    );
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");

    const c = await t.card(0);
    expect(t.text(c)).toContain(JSON.stringify({ draft_id: "r-10", expected: PL_SHOWN }, null, 2));
    expect(t.labels(c)).toEqual(["Allow", "Deny"]);
    expect(sent()).toEqual([]);

    expect(await t.press(c, "Allow")).toBe("Answered");
    await untilRun(routineId, "succeeded");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ via: "drafts", draftId: "r-10" });
  });

  test("a draft edited while the run was parked asks again with its new content and sends nothing", async () => {
    await connectGmail();
    google.draft(DRAFT);
    const t = await link();
    const routineId = await routine();
    host.loopScript(
      {
        match: "send the Anna reply",
        steps: [
          { canUseTool: { tool_name: SEND, input: { draft_id: "r-9" } } },
          { result: "Waiting." },
        ],
      },
      resumes(sends({ draft_id: "r-9" }, "Waiting again.")),
    );
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");
    const first = await t.card(0);
    google.draft({ id: "r-9", mime: "To: spy@example.test\r\nSubject: Draft\r\n\r\nWords" });
    expect(await t.press(first, "Allow")).toBe("Answered");

    const second = await t.card(1);
    expect(t.text(second)).toContain("spy@example.test");
    expect(t.text(second)).not.toContain("eve@example.test");
    await untilRun(routineId, "waiting");
    expect(sent()).toEqual([]);
  });

  test("a parked send expires after 24 hours and sends nothing", async () => {
    await connectGmail();
    const t = await link();
    const routineId = await routine();
    host.loopScript({
      match: "send the Anna reply",
      steps: [{ canUseTool: { tool_name: SEND, input: REPLY } }, { result: "Waiting." }],
    });
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, "waiting");
    const c = await t.card(0);

    host.advanceClock(DAY + 1000);
    expect(await t.press(c, "Allow")).toBe("that wait expired");
    await untilRun(routineId, "failed");
    expect(sent()).toEqual([]);
  });
});

describe("a double-loop task's send", () => {
  const WORKER_CALL = {
    subagent_type: "worker",
    description: "reply to Anna",
    prompt: "Reply to Anna.",
    run_in_background: true,
  };
  const usage = { input_tokens: 1, output_tokens: 1 };

  test("asks with a card naming the task, and the owner's allow sends once", async () => {
    await connectGmail();
    const botId = await openChat("double_loop");
    allowTool(host.db, botId, SEND, Date.now());
    host.loopScript({
      match: "answer Anna",
      steps: [
        { text: "On it." },
        {
          emit: {
            type: "assistant",
            message: {
              id: "msg_agent",
              type: "message",
              role: "assistant",
              model: "fake",
              content: [{ type: "tool_use", id: "tu-agent", name: "Agent", input: WORKER_CALL }],
              stop_reason: "tool_use",
              usage,
            },
            parent_tool_use_id: null,
          },
        },
        {
          hook: "PreToolUse",
          tool_use_id: "tu-agent",
          input: {
            tool_name: "Agent",
            tool_input: WORKER_CALL,
            tool_use_id: "tu-agent",
          },
        },
        {
          emit: {
            type: "system",
            subtype: "task_started",
            task_id: "agent-1",
            tool_use_id: "tu-agent",
            description: WORKER_CALL.description,
            subagent_type: "worker",
          },
        },
        { result: "On it." },
        { canUseTool: { tool_name: SEND, input: REPLY, agent_id: "agent-1" } },
        { mcp: { server: "gmail", tool: "send_message", args: REPLY } },
      ],
    });
    expect((await host.ui("/api/send", { text: "answer Anna" })).status).toBe(200);
    await host.until(() => approvals().length === 1);

    const card = defined(approvals()[0]);
    expect(card.reason).toContain("reply to Anna");
    expect(card.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
    expect(host.permissionResults()).toEqual([]);
    expect(sent()).toEqual([]);

    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => sent().length === 1);
    expect(host.permissionResults()[0]).toMatchObject({
      tool_name: SEND,
      agent_id: "agent-1",
      response: { behavior: "allow" },
    });
    expect(sent()[0]?.headers.subject).toBe(REPLY.subject);
  });
});
