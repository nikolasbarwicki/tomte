// Browser regression for answering a needs-you item from the Needs you bar when the bot may be waiting on a question about it:
//   bun scripts/smoke-needs-you-ui.ts         (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as smoke-answer-ui.ts: a temporary web build served by the whole-host test harness (in-memory database and
// secrets, fake Claude CLI, temporary data root), driven by headless Chrome in a fresh profile. Nothing touches real app data,
// a real model or the OS. Covers: a chip and free text while the bot's held turn has a pending question about the item (the
// question gets the value, no message is queued or sent, the item closes only then), keyboard triage, an idle and a busy bot
// without a question (sent / queued, closed only on delivery), a question whose turn died (its card is marked expired and the
// item can still be answered), and a second page that races the first. Exits non-zero on the first failed check.
import { eventAccess, eventPoster, needsYouView, recordRequests, startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("needs-you-ui");
const { host, page, context, check, pageErrors } = smoke;
const { sends, answers } = recordRequests(page);

const botId = host.createBot("Answers");
const poster = eventPoster(await eventAccess(host, botId));
const post = (title: string, options?: string[]) => poster({ title, ...(options && { options }) });

const { bar, box, needsYou, settled, expand, item } = needsYouView(page, "Answers");
const press = async (title: string, name: string | RegExp) => {
  await expand();
  const before = sends.length;
  await item(title).getByRole("button", { name }).click();
  return before;
};
const sent = async (before: number) => {
  await host.until(() => sends.length > before);
  return sends.at(-1)!;
};
/** A bot that has a held turn with a pending question about the posted item, and the page showing its card. */
const pending = async (title: string, options: string[]) => {
  host.askOnMessage(title, options, { delivered: true });
  const id = await post(title, options);
  await page.getByText(title, { exact: true }).last().waitFor();
  host.stopAsking();
  return id;
};
/** The fake CLI keeps no session state, so a turn that has ended is only seen by waiting a moment. */
const turnsOver = () => Bun.sleep(400);

try {
  await page.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  await box.waitFor();

  console.log("a chip while the bot waits on a question about the item");
  await pending("Which database?", ["Postgres", "SQLite"]);
  await settled(1);
  check(host.toolResults().length === 0, "nothing reached the question before the click");
  const turns = host.messagesOf(botId).length;
  let before = await press("Which database?", "Postgres");
  let s = await sent(before);
  check(
    s.status === 200 && s.json?.outcome === "answered",
    "the host reports the question answered",
  );
  check(
    s.body.eventId !== undefined && s.body.answer === "Postgres",
    "the chip sends the item id and its option",
  );
  await settled(0);
  await bar.waitFor({ state: "detached" });
  await host.until(() => host.toolResults().length === 1);
  check(host.toolResults()[0] === "Postgres", "the question received the option");
  await turnsOver();
  check(host.messagesOf(botId).length === turns, "no chat message was created for the answer");
  check(
    (await page.getByText("Queued · runs after the current turn").count()) === 0,
    "nothing is queued",
  );

  console.log("keyboard triage on a pending question");
  const kbd = await pending("Which cache?", ["Redis", "None"]);
  await settled(1);
  await expand();
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  before = sends.length;
  await page.keyboard.press("Enter");
  s = await sent(before);
  check(
    s.json?.outcome === "answered" && s.body.eventId === kbd && s.body.answer === "Redis",
    "Enter answers the pending question with the first option",
  );
  await settled(0);
  await turnsOver();
  const dismissed = await post("Dismiss me?");
  await settled(1);
  await expand();
  await page.keyboard.press("e");
  await settled(0);
  check(dismissed !== kbd, "e dismisses the item");
  await turnsOver();

  console.log("free text from the composer while the bot waits");
  await pending("Which region?", ["eu", "us"]);
  await settled(1);
  await press("Which region?", /^Other…/);
  check((await box.inputValue()) === "Coordinator · Which region?: ", "Other… fills the draft");
  await box.fill("Coordinator · Which region?: ap-south");
  before = sends.length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  s = await sent(before);
  check(
    s.json?.outcome === "answered" && s.body.answer === undefined,
    "the typed answer resolves the question",
  );
  await settled(0);
  await host.until(() => host.toolResults().length === 3);
  check(
    host.toolResults()[2] === "Coordinator · Which region?: ap-south",
    "the question received the typed text",
  );
  await turnsOver();

  console.log("a second page racing the first");
  const second = await context.newPage();
  await second.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  await second.getByRole("textbox", { name: "Message Answers", exact: true }).waitFor();
  const raced = await pending("Which queue?", ["a", "b"]);
  await settled(1);
  await second
    .getByRole("region", { name: "Needs you", exact: true })
    .getByRole("button", { name: /Needs you/ })
    .waitFor();
  before = await press("Which queue?", "a");
  s = await sent(before);
  check(s.json?.outcome === "answered", "the first device answers the question");
  await settled(0);
  await second
    .getByRole("region", { name: "Needs you", exact: true })
    .waitFor({ state: "detached" });
  const late = await second.evaluate(
    async ([eventId, origin]) => {
      const res = await fetch(`${origin}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "b", eventId, answer: "b" }),
      });
      return { status: res.status, error: ((await res.json()) as { error?: string }).error };
    },
    [raced, host.clientUrl] as const,
  );
  check(
    late.status === 409 && late.error === "that item is already handled",
    "the second device is told the item is handled",
  );
  await turnsOver();
  check(
    host.toolResults().filter((r) => r === "a" || r === "b").length === 1,
    "the question was answered once",
  );
  await second.close();

  console.log("no question pending: an idle bot");
  await post("Ship it?", ["Yes", "No"]);
  await settled(1);
  await turnsOver();
  const turnsBefore = host.messagesOf(botId).length;
  before = await press("Ship it?", "Yes");
  s = await sent(before);
  check(s.json?.outcome === "sent" && s.body.answer === "Yes", "an idle bot is sent the answer");
  await settled(0);
  await host.until(() => host.messagesOf(botId).length === turnsBefore + 1);
  check(
    host.messagesOf(botId).at(-1)?.includes("answer 'Yes'") === true,
    "the bot got the message",
  );
  await turnsOver();

  console.log("no question pending: a busy bot");
  host.hold();
  await box.fill("keep busy");
  await box.press("Enter");
  await host.until(() => host.messagesOf(botId).at(-1) === "keep busy");
  await post("Which colour?", ["Red", "Blue"]);
  await settled(1);
  before = await press("Which colour?", "Blue");
  s = await sent(before);
  check(
    s.status === 200 && s.json?.outcome === "queued",
    "a busy bot queues the answer and says so",
  );
  await page.getByText("Queued · runs after the current turn").waitFor();
  check((await needsYou()) === 1, "the item stays open while its answer is queued");
  check(
    (await bar.locator("li", { hasText: "Which colour?" }).count()) === 1,
    "the item can still be seen and answered",
  );
  host.release();
  await settled(0);
  check(
    host.messagesOf(botId).some((m) => m.includes("answer 'Blue'")),
    "the item closes once the queued answer is delivered",
  );
  await turnsOver();

  console.log("a question whose turn died");
  host.askOnMessage("Which mode?", ["fast", "safe"], { delivered: true, crash: true });
  const dead = await post("Which mode?", ["fast", "safe"]);
  await page.getByText("No longer waiting: its turn ended").waitFor();
  host.stopAsking();
  check(
    (await page.getByRole("button", { name: "fast", exact: true }).count()) === 0,
    "the expired card offers no answers",
  );
  await settled(1);
  before = await press("Which mode?", "safe");
  s = await sent(before);
  check(
    s.json?.outcome === "sent" && s.body.eventId === dead,
    "the item is still answerable: the answer goes to the bot as a message",
  );
  await settled(0);
  check(answers.length === 0, "the Needs you bar never used the transcript's answer route");
  await turnsOver();

  console.log("the transcript's own ask card");
  await pending("Which size?", ["S", "L"]);
  await settled(1);
  await page.getByRole("button", { name: "L", exact: true }).last().click();
  await host.until(() => answers.length === 1);
  await settled(0);
  check(
    host.toolResults().at(-1) === "L",
    "an option on the card still resolves the question and closes its item",
  );

  console.log("an open wait: a question of the bot's own, about no event");
  const results = host.toolResults().length;
  host.askOnMessage("Which environment?", ["prod", "staging"]);
  await box.fill("deploy it");
  await box.press("Enter");
  await page.getByText("Which environment?", { exact: true }).last().waitFor();
  host.stopAsking();
  // The count is the host's: the sidebar badge shows it too, and the card is not counted a second time as a row.
  await settled(1);
  await expand();
  check((await item("Which environment?").count()) === 1, "the open wait is a row of the bar");
  check(
    (await item("Which environment?")
      .getByRole("button", { name: "prod", exact: true })
      .count()) === 1,
    "the row has the card's own buttons",
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await page.keyboard.press("e");
  await Bun.sleep(400);
  check(answers.length === 1, "Enter and e answer nothing");
  check(host.toolResults().length === results, "the question received no answer");
  check((await needsYou()) === 1, "the wait is still open and still counted");
  await item("Which environment?").getByRole("button", { name: "staging", exact: true }).click();
  await host.until(() => answers.length === 2);
  await settled(0);
  await host.until(() => host.toolResults().length === results + 1);
  check(host.toolResults().at(-1) === "staging", "a button of the row answers the question");
  await turnsOver();

  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
