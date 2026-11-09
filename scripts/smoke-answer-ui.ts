// Browser regression for answering a needs-you item with free text (Answer… → edit → Send):
//   bun scripts/smoke-answer-ui.ts            (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Builds the web UI into a temporary directory, serves it from the whole-host test harness (in-memory database, in-memory
// secrets, fake Claude CLI, a temporary data root) and drives it with headless Chrome in a fresh profile. Nothing touches
// real app data, a real model or the OS. Checks the /api/send request and response, the item's state in the transcript,
// and the Needs you bar and the sidebar and Work-tab badges, for: a sent answer, a queued answer, an answer that fails,
// a draft that is replaced, emptied or never sent, and an ordinary message. Exits non-zero on the first failed check.
import { eventAccess, eventPoster, needsYouView, recordRequests, startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("answer-ui");
const { host, page, check, pageErrors } = smoke;
const { sends } = recordRequests(page);

const botId = host.createBot("Answers");
const post = eventPoster(await eventAccess(host, botId));
const ask = (title: string, options?: string[]) => post({ title, ...(options && { options }) });

const { bar, box, needsYou, settled, expand, item } = needsYouView(page, "Answers");
const answer = async (title: string) => {
  await expand();
  await item(title)
    .getByRole("button", { name: /^Answer…/ })
    .click();
};
const send = async () => {
  const before = sends.length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await host.until(() => sends.length > before);
  return sends.at(-1)!;
};
const idle = async (turns: number) => {
  await host.until(() => host.messagesOf(botId).length >= turns);
  await Bun.sleep(300);
};

try {
  await page.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  await box.waitFor();

  console.log("a sent answer");
  await ask("Custom command?");
  await idle(1);
  await settled(1);
  await answer("Custom command?");
  check((await box.inputValue()) === "Coordinator · Custom command?: ", "Answer… fills the draft");
  check(page.url().includes("draftEvent") === false, "the draft's event id leaves the URL");
  await box.fill("Coordinator · Custom command?: use --safe");
  const sent = await send();
  check(
    sent.status === 200 && sent.body.eventId !== undefined,
    "Send carries the event id and is accepted",
  );
  check(
    (sent.json as { queued?: string }).queued === undefined,
    "an idle bot starts the turn at once",
  );
  await settled(0);
  await bar.waitFor({ state: "detached" });
  check(
    host.messagesOf(botId).at(-1)?.includes("use --safe") === true,
    "the answer reaches the bot",
  );
  await idle(2);

  console.log("a draft that is emptied, replaced or never sent");
  const kept = await ask("Which database?");
  const other = await ask("Which cache?");
  await idle(4);
  await settled(2);
  await answer("Which database?");
  check(sends.length === 1, "opening a draft sends nothing");
  await box.fill("");
  await box.fill("just a thought");
  const plain = await send();
  check(plain.body.eventId === undefined, "text typed after emptying the draft is not an answer");
  await idle(5);
  await settled(2);
  await answer("Which database?");
  await answer("Which cache?");
  check(
    (await box.inputValue()) === "Coordinator · Which cache?: ",
    "a second Answer… replaces the draft",
  );
  await page.reload();
  await box.waitFor();
  await settled(2);
  check(host.messagesOf(botId).length === 5, "reloading with an unsent draft sends nothing");

  console.log("an answer that fails");
  await answer("Which cache?");
  await box.fill("Coordinator · Which cache?: redis");
  await page.route("**/api/send", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  const failed = await send();
  check(failed.status === 500, "the failing request is rejected");
  await page.unroute("**/api/send");
  await settled(2);
  check(
    (await box.inputValue()) === "Coordinator · Which cache?: redis",
    "a failed send restores the text",
  );
  const retried = await send();
  check(
    retried.status === 200 && retried.body.eventId === other,
    "the retry still answers that item",
  );
  await settled(1);
  check(kept !== other, "the other item is still open");
  await idle(6);

  console.log("a queued answer");
  host.hold();
  await box.fill("keep busy");
  await send();
  await host.until(() => host.messagesOf(botId).at(-1) === "keep busy");
  await answer("Which database?");
  await box.fill("Coordinator · Which database?: postgres");
  const queued = await send();
  check(
    typeof (queued.json as { queued?: string }).queued === "string",
    "a busy bot queues the answer",
  );
  await page.getByText("Queued · runs after the current turn").waitFor();
  await settled(1);
  check((await needsYou()) === 1, "the item stays open while its answer is queued");
  host.release();
  await settled(0);
  check(
    host.messagesOf(botId).some((m) => m.includes("postgres")),
    "the item closes once the answer is delivered",
  );

  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
