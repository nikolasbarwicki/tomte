// Browser regression for the Channels page against a fake Telegram Bot API server:
//   bun scripts/smoke-channels-ui.ts         (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as the other smokes (scripts/smoke-kit.ts): a temporary web build served by the whole-host test harness (in-memory
// database and secrets, temporary data root), driven by headless Chrome in a fresh profile. The host's Telegram adapter is pointed at
// packages/host/src/testing/fake-telegram.ts on a loopback port, so api.telegram.org is never contacted and no real token exists.
// Covers: no token yet, a token Telegram rejects, a token it accepts (the page shows the bot running and never the token), the link code
// with its t.me deep link, linking by sending the code through the fake server, a stranger getting no reply, the linked state, and Unlink.
// Exits non-zero on the first failed check.
import { fakeTelegram } from "../packages/host/src/testing/fake-telegram.ts";
import { startSmoke } from "./smoke-kit.ts";

const telegram = fakeTelegram();
const smoke = await startSmoke("channels-ui", {
  timing: {
    telegram: {
      baseUrl: telegram.url,
      pollTimeoutSeconds: 2,
      sendSpacingMs: 0,
      backoffMs: 50,
    },
  },
});
const { host, page, check, pageErrors } = smoke;

const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const stranger = { id: 999, first_name: "Stranger" };
const status = page.getByTestId("telegram-status");
const tokenField = page.getByLabel("Bot token");

try {
  await page.goto(`${host.clientUrl}/channels`);
  await status.waitFor();

  console.log("no token yet");
  check((await status.textContent()) === "No bot token yet", "the page says there is no bot token");
  check(
    await page.getByRole("button", { name: "Link account" }).isDisabled(),
    "Link account waits for a running bot",
  );
  await smoke.shot("no-token");

  console.log("a token Telegram rejects");
  await tokenField.fill("123:wrong-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByText("Telegram rejected this bot token").waitFor();
  check((await status.textContent()) === "No bot token yet", "the bot is still not set up");
  check(
    !host.secretNames().includes("channel-token:telegram"),
    "the rejected token was not stored",
  );
  check(telegram.of("getUpdates").length === 0, "nothing polls with a rejected token");

  console.log("a token Telegram accepts");
  await tokenField.fill(telegram.token);
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByText(`Running as @${telegram.username}`).waitFor();
  check(
    (await tokenField.inputValue()) === "",
    "the token field is empty again: the token is never shown",
  );
  check(!(await page.content()).includes(telegram.token), "the token is nowhere in the page");
  check(host.secretNames().includes("channel-token:telegram"), "the token is in the secrets store");
  await host.until(() => telegram.of("getUpdates").length > 0);
  check(
    telegram.of("getUpdates")[0]!.params.timeout === 2,
    "the host long polls with the configured timeout",
  );
  await smoke.shot("running");

  console.log("the link code and the t.me link");
  await page.getByRole("button", { name: "Link account" }).click();
  const dialog = page.getByRole("dialog");
  const code = (await dialog.locator("code").textContent())!;
  check(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){2}$/.test(code), `the dialog shows a code (${code})`);
  const deepLink = `https://t.me/${telegram.username}?start=${code}`;
  check(
    (await dialog.getByRole("link").getAttribute("href")) === deepLink,
    "the dialog links to the bot with the code filled in",
  );
  await smoke.shot("link-dialog");

  console.log("a stranger gets nothing, the owner links with /start <code>");
  const strangerUpdate = telegram.message(stranger, `/start ${code.toLowerCase()}x`);
  await host.until(() =>
    telegram
      .of("getUpdates")
      .some((c) => typeof c.params.offset === "number" && c.params.offset > strangerUpdate),
  );
  check(
    telegram.outgoing().length === 0,
    "a stranger's /start with something that is not a code was answered with nothing",
  );
  telegram.message(owner, `/start ${code}`);
  await host.until(() => telegram.texts().length === 1);
  check(
    telegram.of("sendMessage")[0]!.params.chat_id === owner.id,
    "the confirmation went to the owner's chat",
  );

  console.log("the linked state");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByText("Owner One · linked").waitFor();
  check(await page.getByText("Linked", { exact: true }).isVisible(), "the page shows Linked");
  check(
    host.server.channels.linkOf("telegram")?.id === String(owner.id),
    "the host linked the owner",
  );
  await smoke.shot("linked");

  console.log("Unlink");
  await page.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
  await page.getByText("Not linked", { exact: true }).first().waitFor();
  check(host.server.channels.linkOf("telegram") === undefined, "the host has no link any more");
  check(
    host.secretNames().includes("channel-token:telegram"),
    "unlinking left the bot token in place",
  );
  check(
    (await status.textContent()) === `Running as @${telegram.username}`,
    "the bot keeps running after Unlink",
  );
  await smoke.shot("unlinked");

  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
} finally {
  await telegram.stop();
}
