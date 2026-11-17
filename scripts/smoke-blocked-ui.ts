// Browser regression for a blocked report sent by the real tomte-notify program:
//   bun scripts/smoke-blocked-ui.ts           (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as smoke-needs-you-ui.ts: a temporary web build served by the whole-host test harness (in-memory database and
// secrets, fake Claude CLI, temporary data root), driven by headless Chrome in a fresh profile; the sender runs as a
// subprocess in a temporary HOME with only the bot's route in its environment. Nothing touches real app data, a real
// model, a real coordinator or the OS. Covers: a blocked report showing in the Needs you bar and as "Blocked" in Work ahead
// of a failure, `Unblock…` preparing a draft that closes the item when sent, and `Status` sending its question as an answer.
// Exits non-zero on the first failed check.
import { eventAccess, needsYouView, recordRequests, runNotify, startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("blocked-ui");
const { host, page, check, pageErrors, runDir } = smoke;
const { sends } = recordRequests(page);

const botId = host.createBot("Planner");
const access = await eventAccess(host, botId);
/** The real sender as a subprocess in the run directory; returns what it printed and its exit code. */
const notify = (...argv: string[]) => runNotify(access, runDir, argv);

const { box, settled, expand, item } = needsYouView(page, "Planner");

try {
  await page.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  await box.waitFor();

  console.log("a blocked and a failed report from the sender");
  const failed = await notify("failed", "05-relay", "omp-7", "Tests are red");
  check(failed.out === "ok" && failed.code === 0, "the sender prints ok for a failed report");
  const blocked = await notify(
    "blocked",
    "04-notify",
    "omp-7",
    "Waiting for the staging key\nIt is in 1Password.",
  );
  check(blocked.out === "ok" && blocked.code === 0, "the sender prints ok for a blocked report");
  await settled(2);
  await expand();
  check(
    (await item("Waiting for the staging key").count()) === 1,
    "the blocked item is in Needs you",
  );
  check((await item("Tests are red").count()) === 1, "the failed item is in Needs you");

  const cards = page.locator("li > button", { has: page.locator("span.font-medium[title]") });
  await cards.first().waitFor();
  const labels = await cards.locator("span.font-medium[title]").allInnerTexts();
  check(
    labels.join(",") === "04-notify,05-relay",
    `Work lists the blocked source before the failed one (${labels.join(", ")})`,
  );
  check(
    (await cards.filter({ hasText: "04-notify" }).getByText("Blocked", { exact: true }).count()) ===
      1,
    "the blocked source's card shows the Blocked status",
  );
  check(
    (await cards.filter({ hasText: "05-relay" }).getByText("Failed", { exact: true }).count()) ===
      1,
    "the failed source's card shows Failed",
  );

  console.log("Unblock… prepares a draft that closes the item");
  await item("Waiting for the staging key")
    .getByRole("button", { name: /^Unblock…/ })
    .click();
  check(
    (await box.inputValue()) === "04-notify · Waiting for the staging key: ",
    "Unblock… fills the draft",
  );
  await box.pressSequentially("key is in the vault");
  const before = sends.length;
  await box.press("Enter");
  await host.until(() => sends.length > before);
  const answer = sends.at(-1)!;
  check(answer.status === 200, "the answer is accepted");
  check(
    answer.body.eventId !== undefined &&
      answer.body.text === "04-notify · Waiting for the staging key: key is in the vault",
    "the answer carries the blocked item's id",
  );
  await settled(1);
  check(
    (await item("Waiting for the staging key").count()) === 0,
    "the blocked item left Needs you",
  );
  check((await item("Tests are red").count()) === 1, "the failed item stays");

  console.log("Status asks the bot about the item, as it does for a failed one");
  await notify("blocked", "06-docs", "omp-8", "Need a decision on the docs layout");
  await settled(2);
  await expand();
  const sendsBefore = sends.length;
  await item("Need a decision on the docs layout").getByRole("button", { name: "Status" }).click();
  await host.until(() => sends.length > sendsBefore);
  const status = sends.at(-1)!;
  check(
    status.body.text === "Status 06-docs: Need a decision on the docs layout" &&
      status.body.eventId !== undefined,
    "Status sends its question with the blocked item's id",
  );
  check(status.status === 200, "the host accepts it");
  await settled(1);
  check(
    (await item("Need a decision on the docs layout").count()) === 0,
    "the item closes once the message reaches the bot",
  );

  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
