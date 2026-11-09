// End-to-end smoke of the external-event answer round trip: the real `claudebot-notify` posts a report, the real UI answers it,
// and the host relays the answer to a fake `herdr` executable that records its argument list.
//   bun run smoke:answers          (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Everything is isolated in one run directory (see smoke-kit.ts): a temporary data root, in-memory database and secrets, the fake
// Claude CLI, a temporary web build, headless Chrome in a fresh profile, a relay.json (ADR-0008) whose only adapter runs the fake
// `herdr`, which appends `{argv, exit}` to a JSON-lines file. No real herdr, coordinator, model, app data, keychain or OS dialog is
// involved. Flows, each checked in the browser and against the recorded argument lists:
//   1. Needs you `Answer…` -> edit -> Send, from a report the sender posted (Needs you, Work and transcript all show it)
//   2. a transcript ask chip and 3. a transcript free-text answer for an ask the bot raised for the report, with an explicit session
//   4. an ordinary ask leaves an unrelated open question alone
//   5. a Needs-you answer (free text and chip) while the bot holds a genuinely pending ask
//   6. queued input is never delivered or relayed until it reaches the bot
//   7. `blocked`, 8. a failing relay, its visible failure and one Retry, 9. duplicate answers (double click, second device, replays,
//   a repeated report), 10. injection-safe argv, 11. an adapter that is not configured and an item without a target.
// Exits non-zero on the first failed check and keeps the run directory (screenshots, host log, page console, recorded argv).
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defined } from "../packages/host/src/testing/defined.ts";
import {
  eventAccess,
  eventPoster,
  needsYouView,
  recordRequests,
  runNotify,
  startSmoke,
} from "./smoke-kit.ts";

interface RelayCall {
  argv: string[];
  exit: number;
}
interface FakeHerdr {
  command: string;
  calls(): Promise<RelayCall[]>;
  setExit(code: number): Promise<void>;
}

/** The fake `herdr`: an executable that appends `{argv, exit}` to a file and exits with the status in another. */
async function fakeHerdr(dir: string): Promise<FakeHerdr> {
  const log = join(dir, "herdr-argv.jsonl");
  const status = join(dir, "herdr-exit");
  const recorder = join(dir, "herdr-record.mjs");
  const command = join(dir, "herdr");
  await writeFile(status, "0");
  await writeFile(
    recorder,
    [
      `import { appendFileSync, readFileSync } from "node:fs";`,
      `const exit = Number(readFileSync(${JSON.stringify(status)}, "utf8"));`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), exit }) + "\\n");`,
      `if (exit !== 0) { console.error("herdr: agent coord is offline"); process.exit(exit); }`,
      "",
    ].join("\n"),
  );
  await writeFile(
    command,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`,
  );
  await chmod(command, 0o755);
  return {
    command,
    async calls() {
      const text = await Bun.file(log)
        .text()
        .catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RelayCall);
    },
    setExit: (code) => writeFile(status, String(code)),
  };
}

let herdrHandle: FakeHerdr | undefined;
const smoke = await startSmoke("answers", {
  async hostFlags(dir) {
    const herdr = await fakeHerdr(dir);
    herdrHandle = herdr;
    const config = join(dir, "relay.json");
    await writeFile(
      config,
      JSON.stringify({
        adapters: {
          herdr: {
            command: herdr.command,
            // The shape of `herdr agent prompt <agent> "<answer> (<question id>)" --session <session>`.
            args: ["agent", "prompt", "{agent}", "{message}", "--session", "{session}"],
            defaultSession: "default",
            allowAgents: ["coord"],
            timeoutMs: 10_000,
          },
        },
      }),
    );
    await chmod(config, 0o600);
    return ["--relay-config", config];
  },
});
const herdr = defined(herdrHandle, "the fake herdr");
const { host, page, check, pageErrors, runDir } = smoke;
const { sends, answers } = recordRequests(page);

const botId = host.createBot("Answers");
const access = await eventAccess(host, botId);
const post = eventPoster(access);
/** The real sender as a subprocess in the run directory. */
const notify = (...argv: string[]) => runNotify(access, runDir, argv);
const { bar, box, needsYou, settled, expand, item } = needsYouView(page, "Answers");

const argvOf = (message: string, session = "default") => [
  "agent",
  "prompt",
  "coord",
  message,
  "--session",
  session,
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const REPLY = ["--reply", "herdr:coord"];

/** Waits until the relay has run `total` times in all, then a moment longer, and checks that it did not run more often. */
async function relayRuns(total: number, what: string) {
  for (let i = 0; i < 200 && (await herdr.calls()).length < total; i++) await Bun.sleep(25);
  await Bun.sleep(500);
  const seen = await herdr.calls();
  check(
    seen.length === total,
    `${what}: the relay has run ${total} times in all (saw ${seen.length})`,
  );
  return seen;
}
/** The bot has taken every message it will take for now. */
async function calm() {
  for (let before = -1, now = 0; before !== now;) {
    before = now;
    await Bun.sleep(400);
    now = host.messagesOf(botId).length;
  }
}
const cards = page.locator("li > button", { has: page.locator("span.font-medium[title]") });
const sendButton = page.getByRole("button", { name: "Send", exact: true });
const lastSend = () => defined(sends.at(-1), "a send");
const delivered = () => page.getByText("Reply delivered");
const failedAlert = page.getByRole("alert").filter({ hasText: "Reply not delivered" });

/** Needs you `Answer…`/`Unblock…` on the item, then the typed text after the draft the page prepared; returns the draft. */
async function draftAnswer(title: string, button: RegExp, text: string) {
  await expand();
  await item(title).getByRole("button", { name: button }).click();
  const draft = await box.inputValue();
  await box.fill(draft + text);
  const before = sends.length;
  await sendButton.click();
  await host.until(() => sends.length > before);
  return draft;
}

try {
  await page.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  await box.waitFor();
  check(
    herdr.command.startsWith(runDir) && !herdr.command.includes("/opt/homebrew"),
    "the relay runs the fake herdr in the run directory, never a real one",
  );

  console.log("1. a report from the sender, answered with Answer… → edit → Send");
  const first = await notify(...REPLY, "question", "T-db", "omp-1", "Which database?", "Q-1");
  check(first.out === "ok" && first.code === 0, "the sender posts the question and prints ok");
  await calm();
  await settled(1);
  await expand();
  check((await item("Which database?").count()) === 1, "Needs you lists the question");
  check(
    (await page.getByText("in Needs you", { exact: true }).count()) === 1,
    "the transcript row says it is in Needs you",
  );
  check(
    (await cards.filter({ hasText: "T-db" }).getByText("Needs you", { exact: true }).count()) === 1,
    "Work shows the source as needing the user",
  );
  check((await herdr.calls()).length === 0, "nothing is relayed before the user answers");
  await smoke.shot("question-in-needs-you");
  const draft = await draftAnswer("Which database?", /^Answer…/, "use Postgres 16");
  check(draft === "T-db · Which database?: ", "Answer… prepares a draft for that source and title");
  check(
    lastSend().status === 200 &&
      lastSend().json?.outcome === "sent" &&
      lastSend().body.eventId !== undefined,
    "Send is accepted as an answer to that item",
  );
  await settled(0);
  await bar.waitFor({ state: "detached" });
  let seen = await relayRuns(1, "Answer…");
  check(
    same(seen[0], { argv: argvOf("use Postgres 16 (Q-1)"), exit: 0 }),
    'the fake herdr got `agent prompt coord "use Postgres 16 (Q-1)" --session default`',
  );
  await delivered().last().waitFor();
  check(
    (await page.getByText("handled", { exact: true }).count()) === 1,
    "the transcript row is handled",
  );
  check(
    (await cards.filter({ hasText: "T-db" }).getByText("Needs you", { exact: true }).count()) === 0,
    "Work no longer shows the source as needing the user",
  );
  await smoke.shot("answered-and-relayed");
  await page.reload();
  await box.waitFor();
  await settled(0);
  await delivered().last().waitFor();
  check(
    (await delivered().count()) === 1,
    "after a reload the answer is still handled and delivered",
  );
  seen = await relayRuns(1, "reload");

  console.log("2. a transcript ask chip for an ask raised about the report (explicit session)");
  host.askOnMessage("Which branch?", ["main", "dev"], { delivered: true });
  const second = await notify(
    ...REPLY,
    "--reply-session",
    "s-explicit",
    "question",
    "T-branch",
    "omp-1",
    "Pick a branch",
    "Q-2",
  );
  check(second.code === 0, "the sender posts the second question");
  await page.getByText("Which branch?", { exact: true }).last().waitFor();
  host.stopAsking();
  await settled(1);
  check(
    (await page.getByText("in Needs you", { exact: true }).count()) === 1,
    "the report is in Needs you while the bot waits",
  );
  await relayRuns(1, "before the chip");
  await smoke.shot("ask-pending");
  const sendsBefore = sends.length;
  await page.getByRole("button", { name: "main", exact: true }).last().click();
  await host.until(() => host.toolResults().length === 1);
  check(host.toolResults()[0] === "main", "the ask received the chip's value");
  await settled(0);
  seen = await relayRuns(2, "chip");
  check(
    same(seen[1], { argv: argvOf("main (Q-2)", "s-explicit"), exit: 0 }),
    "the fake herdr got `main (Q-2)` for session s-explicit",
  );
  check(answers.length === 1 && sends.length === sendsBefore, "the chip used /api/answer only");
  const answeredAsk = defined(answers.at(0)?.body.id, "the answered ask's id");
  await page.getByText("handled", { exact: true }).last().waitFor();
  await page.reload();
  await box.waitFor();
  await settled(0);
  check(
    (await page.getByText("in Needs you", { exact: true }).count()) === 0,
    "after a reload nothing is in Needs you",
  );
  await relayRuns(2, "reload after the chip");

  console.log("3. a transcript free-text answer for a linked ask");
  host.askOnMessage("Which tag?", undefined, { delivered: true });
  const third = await notify(...REPLY, "question", "T-tag", "omp-1", "Pick a tag", "Q-3");
  check(third.code === 0, "the sender posts the third question");
  await page.getByText("Which tag?", { exact: true }).last().waitFor();
  host.stopAsking();
  await settled(1);
  await page.getByPlaceholder("Your answer").fill("v2.1");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await host.until(() => host.toolResults().length === 2);
  check(host.toolResults()[1] === "v2.1", "the ask received the typed text");
  await settled(0);
  seen = await relayRuns(3, "free text");
  check(
    same(seen[2], { argv: argvOf("v2.1 (Q-3)"), exit: 0 }),
    "the fake herdr got `v2.1 (Q-3)` for the default session",
  );
  await page.reload();
  await box.waitFor();
  await settled(0);

  console.log("4. an ordinary ask leaves an unrelated open question alone");
  await post({ title: "Unrelated question" });
  await calm();
  await settled(1);
  host.askOnMessage("Your name?");
  await box.fill("go");
  await box.press("Enter");
  await page.getByText("Your name?", { exact: true }).waitFor();
  host.stopAsking();
  await page.getByPlaceholder("Your answer").fill("Ada");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await host.until(() => host.toolResults().length === 3);
  check(host.toolResults()[2] === "Ada", "the ordinary ask received its answer");
  await calm();
  await settled(1);
  check(
    (await page.getByText("in Needs you", { exact: true }).count()) === 1,
    "the unrelated question is still open",
  );
  await expand();
  await page.keyboard.press("e");
  await settled(0);
  check((await needsYou()) === 0, "dismissing it closes it");
  await relayRuns(3, "ordinary ask and dismissal");

  console.log("5. a Needs-you answer while the bot holds a pending ask");
  host.askOnMessage("Which region?", ["eu", "us"], { delivered: true });
  await notify(...REPLY, "question", "T-region", "omp-1", "Pick a region", "Q-4");
  await page.getByText("Which region?", { exact: true }).last().waitFor();
  host.stopAsking();
  await settled(1);
  let turns = host.messagesOf(botId).length;
  const toolResults = host.toolResults().length;
  const regionDraft = await draftAnswer("Pick a region", /^Answer…/, "eu-west");
  check(
    lastSend().json?.outcome === "answered",
    "the host routes the answer to the pending ask, not to the chat",
  );
  await host.until(() => host.toolResults().length === toolResults + 1);
  check(
    host.toolResults().at(-1) === `${regionDraft}eu-west`,
    "the pending ask received what was sent",
  );
  await settled(0);
  await calm();
  check(host.messagesOf(botId).length === turns, "no chat message was created for the answer");
  check(
    (await page.getByText("Queued · runs after the current turn").count()) === 0,
    "nothing is queued",
  );
  seen = await relayRuns(4, "pending ask, free text");
  check(
    same(seen[3], { argv: argvOf("eu-west (Q-4)"), exit: 0 }),
    "the fake herdr got the typed answer without the draft prefix",
  );
  host.askOnMessage("Which size?", ["S", "L"], { delivered: true });
  await post({
    title: "Pick a size",
    options: ["S", "L"],
    questionId: "Q-5",
    reply: { kind: "herdr", agent: "coord" },
  });
  await page.getByText("Which size?", { exact: true }).last().waitFor();
  host.stopAsking();
  await settled(1);
  await relayRuns(4, "before the Needs-you chip");
  turns = host.messagesOf(botId).length;
  await expand();
  await item("Pick a size").getByRole("button", { name: "L", exact: true }).click();
  await host.until(() => host.toolResults().length === toolResults + 2);
  check(host.toolResults().at(-1) === "L", "the pending ask received the Needs-you chip's option");
  check(lastSend().json?.outcome === "answered", "the host reports the chip as an answer");
  await settled(0);
  await calm();
  check(host.messagesOf(botId).length === turns, "no chat message was created for the chip");
  seen = await relayRuns(5, "pending ask, chip");
  check(same(seen[4], { argv: argvOf("L (Q-5)"), exit: 0 }), "the fake herdr got `L (Q-5)`");

  console.log("6. queued input is not delivered, and so is not relayed");
  const deliveredBefore = await delivered().count();
  host.hold();
  await box.fill("keep busy");
  await box.press("Enter");
  await host.until(() => host.messagesOf(botId).at(-1) === "keep busy");
  await notify(...REPLY, "question", "T-queue", "omp-1", "Which color?", "Q-6");
  await settled(1);
  await draftAnswer("Which color?", /^Answer…/, "blue");
  check(
    lastSend().status === 200 && lastSend().json?.outcome === "queued",
    "a busy bot queues the answer and says so",
  );
  await page.getByText("Queued · runs after the current turn").waitFor();
  await Bun.sleep(600);
  check((await needsYou()) === 1, "the item stays open while the answer is queued");
  check(
    (await delivered().count()) === deliveredBefore && (await failedAlert.count()) === 0,
    "no relay result is shown for it",
  );
  await relayRuns(5, "while queued");
  await smoke.shot("queued-not-relayed");
  host.release();
  await settled(0);
  check(
    host.messagesOf(botId).some((m) => m.includes("blue")),
    "the answer reached the bot once the turn ended",
  );
  seen = await relayRuns(6, "after delivery");
  check(same(seen[5], { argv: argvOf("blue (Q-6)"), exit: 0 }), "the fake herdr got `blue (Q-6)`");
  await calm();

  console.log("7. a blocked report");
  await notify(...REPLY, "blocked", "T-blk", "omp-1", "Waiting for the staging key");
  await calm();
  await settled(1);
  check(
    (await cards.filter({ hasText: "T-blk" }).getByText("Blocked", { exact: true }).count()) === 1,
    "Work shows the source as blocked",
  );
  await draftAnswer("Waiting for the staging key", /^Unblock…/, "key is in the vault");
  await settled(0);
  seen = await relayRuns(7, "blocked");
  check(
    same(seen[6], { argv: argvOf("key is in the vault"), exit: 0 }),
    "the fake herdr got the answer alone, since the report had no question id",
  );
  await calm();

  console.log("8. a failing relay, then Retry");
  await herdr.setExit(3);
  await notify(...REPLY, "question", "T-fail", "omp-1", "Which port?", "Q-7");
  await calm();
  await settled(1);
  await draftAnswer("Which port?", /^Answer…/, "8080");
  const failedId = defined(lastSend().body.eventId, "the answered item");
  await settled(0);
  await failedAlert.first().waitFor();
  check(
    (await failedAlert.first().innerText()).includes("exited with 3"),
    "the page shows that the reply was not delivered, with the exit status",
  );
  seen = await relayRuns(8, "failing relay");
  check(
    same(seen[7], { argv: argvOf("8080 (Q-7)"), exit: 3 }),
    "the fake herdr was run once and failed",
  );
  await smoke.shot("relay-failed");
  await page.reload();
  await box.waitFor();
  await failedAlert.first().waitFor();
  check((await failedAlert.count()) >= 1, "the failure is still shown after a reload");
  await herdr.setExit(0);
  await failedAlert.first().getByRole("button", { name: "Retry" }).click();
  await failedAlert.first().waitFor({ state: "detached" });
  await delivered().last().waitFor();
  seen = await relayRuns(9, "Retry");
  check(
    same(seen[8], { argv: argvOf("8080 (Q-7)"), exit: 0 }),
    "Retry ran the fake herdr once more with the same arguments, and it succeeded",
  );
  check(
    seen.filter((c) => c.argv[3] === "8080 (Q-7)" && c.exit === 0).length === 1,
    "exactly one successful relay for that answer",
  );
  const replay = await host.ui("/api/bots/events/relay/retry", { botId, id: failedId });
  await replay.text();
  await relayRuns(9, "a Retry replayed after delivery");
  await smoke.shot("relay-retried");

  console.log("9. duplicate answers");
  const dup = await post({
    title: "Ship it?",
    options: ["Yes", "No"],
    questionId: "Q-8",
    reply: { kind: "herdr", agent: "coord" },
  });
  await calm();
  await settled(1);
  const device = await smoke.newPage();
  await device.goto(`${host.clientUrl}/bots/${botId}?panel=work`);
  const other = needsYouView(device, "Answers");
  await other.box.waitFor();
  await other.settled(1);
  const raw = () => host.ui("/api/send", { text: "Yes", eventId: dup, answer: "Yes" });
  await expand();
  const [first1, first2] = await Promise.all([
    raw().then((r) => r.status),
    raw().then((r) => r.status),
    item("Ship it?")
      .getByRole("button", { name: "Yes", exact: true })
      .dblclick({ timeout: 2000 })
      .catch(() => undefined),
  ]);
  const pageWins = sends.filter((s) => s.body.eventId === dup && s.status === 200).length;
  const winners = [first1, first2].filter((s) => s === 200).length + pageWins;
  check(winners === 1, `exactly one of the concurrent answers was accepted (${winners})`);
  await settled(0);
  await other.settled(0);
  check((await other.needsYou()) === 0, "the second device sees the item close");
  seen = await relayRuns(10, "double click and a second device");
  check(same(seen[9], { argv: argvOf("Yes (Q-8)"), exit: 0 }), "the fake herdr got `Yes (Q-8)`");
  const late = await raw();
  check(late.status === 409, "a late replay of the answer is refused as already handled");
  const askReplay = await host.ui("/api/answer", { id: answeredAsk, value: "main" });
  check(askReplay.status === 404, "a replayed ask answer finds no such question");
  const repeated = await notify(...REPLY, "question", "T-db", "omp-1", "Which database?", "Q-1");
  check(
    repeated.out === "ok (duplicate)" && repeated.code === 0,
    "the sender's repeated report is a successful duplicate",
  );
  await calm();
  await settled(0);
  await relayRuns(10, "replays");
  await device.close();

  console.log("10. injection-safe argv");
  const canaries = [1, 2, 3].map((n) => join(runDir, `pwned-${n}`));
  const hostile = [
    `it's "quoted"; $(touch ${canaries[0]}) \`touch ${canaries[1]}\` && touch ${canaries[2]} | cat`,
    "second line \\n $HOME ${IFS} *",
    "-n --session evil",
  ].join("\n");
  const refusedTarget = await notify(
    "--reply",
    "herdr:coord;touch x",
    "question",
    "T-x",
    "s",
    "Q?",
  );
  check(refusedTarget.code === 2, "the sender refuses a reply target with shell syntax");
  const refusedSession = await notify(
    ...REPLY,
    "--reply-session",
    "$(id)",
    "question",
    "T-x",
    "s",
    "Q?",
  );
  check(refusedSession.code === 2, "the sender refuses a reply session with shell syntax");
  const route = await fetch(access.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${access.token}` },
    body: JSON.stringify({
      kind: "question",
      key: "raw-hostile",
      source: { id: "x", label: "x" },
      title: "x",
      reply: { kind: "herdr", agent: "coord; touch x" },
    }),
  });
  check(route.status === 400, "the events route refuses it as well");
  await notify(...REPLY, "question", "T-inj", "omp-1", "Which shell?", "Q-9");
  await calm();
  await settled(1);
  await draftAnswer("Which shell?", /^Answer…/, hostile);
  await settled(0);
  seen = await relayRuns(11, "hostile answer");
  const hostileCall = defined(seen[10], "the hostile relay call");
  check(hostileCall.argv.length === 6, "the answer is one argument: the list has six elements");
  check(
    same(hostileCall.argv, argvOf(`${hostile} (Q-9)`)),
    "the answer arrived byte for byte as one argument",
  );
  for (const canary of canaries)
    check(!(await Bun.file(canary).exists()), `nothing was executed (${canary.split("/").at(-1)})`);

  console.log("11. an adapter that is not configured, and an item without a target");
  await post({
    title: "Which queue?",
    reply: { kind: "nope", agent: "coord" },
  });
  await calm();
  await settled(1);
  await draftAnswer("Which queue?", /^Answer…/, "a");
  await settled(0);
  await page
    .getByRole("alert")
    .filter({ hasText: 'no relay adapter named "nope" is configured' })
    .first()
    .waitFor();
  await relayRuns(11, "an adapter that is not configured");
  await notify("question", "T-plain", "omp-1", "Which color now?");
  await calm();
  await settled(1);
  await draftAnswer("Which color now?", /^Answer…/, "green");
  await settled(0);
  await calm();
  check(
    host.messagesOf(botId).some((m) => m.includes("green")),
    "the answer reached the bot",
  );
  await relayRuns(11, "an item without a target");
  check((await page.getByText("Sending your reply…").count()) === 0, "no relay is still pending");

  console.log("the recorded argument lists:");
  for (const call of await herdr.calls())
    console.log(`  exit ${call.exit}: ${JSON.stringify(call.argv)}`);
  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
