// README screenshots and hero animation:
//   bun run shots:readme        (CHROME_PATH names a Chrome/Chromium binary; ffmpeg must be installed for the GIF)
// Seeds a demo host with the smoke harness (scripts/smoke-kit.ts: whole-host test harness, fake Claude CLI, fake Telegram Bot API; no
// network, no model) and writes `<name>-light.png` and `<name>-dark.png` for each shot, plus `hero.gif`, to `.github/assets/screens/`.
// The two themes are the page's own: next-themes follows `prefers-color-scheme`, which Playwright's `emulateMedia` sets.
// Nothing time-dependent is on a shot: transcripts come from session files with fixed times, and the remaining clocks, ports and ids
// are blanked by `MASK` below. Nothing outside the output folder and the smoke's run directory is written.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { fakeTelegram } from "../packages/host/src/testing/fake-telegram.ts";
import { writeSession } from "../packages/host/src/testing/session-file.ts";
import { DEMO_SCRIPTS, REPORT } from "./shots-kit.ts";
import { eventAccess, eventPoster, startSmoke } from "./smoke-kit.ts";

const OUT = join(import.meta.dir, "../.github/assets/screens");
const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
const VIEWPORT = { width: 1400, height: 900 };
const THEMES = ["light", "dark"] as const;
/** Epoch ms the seeded conversations start at; transcripts show these, never the real clock. */
const T0 = Date.UTC(2025, 5, 3, 9, 12);

/** Stops motion and the caret; adopted as a stylesheet because the page's CSP refuses an inline `<style>`. */
const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`;

/**
 * Runs in every page: the host stamps real times on runs, links and the sidebar, so each date, clock time and "N min ago" the page
 * renders is rewritten to a fixed one, again after every change of the page. `Next run` keeps its clock (the schedule is fixed).
 */
const fixClocks = (still: string) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(still);
  document.adoptedStyleSheets = [sheet];
  const DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(, \d{4})?/g;
  const CLOCK = /\b\d{1,2}:\d{2}(:\d{2})? ?[AP]M\b/g;
  const AGO = /\b(just now|\d+ ?(s|m|min|h|d|sec|minutes?|hours?|days?) ago)\b/g;
  const fix = (el: Element) => {
    const text = el.textContent ?? "";
    const next = text.startsWith("Next run")
      ? text.replace(DATE, "Jun 4")
      : text.replace(DATE, "Jun 3").replace(CLOCK, "09:12 AM").replace(AGO, "just now");
    if (next !== text) el.textContent = next;
  };
  let queued = false;
  const sweep = () => {
    queued = false;
    for (const el of document.querySelectorAll("body *"))
      if (el.children.length === 0 && el.textContent) fix(el);
  };
  new MutationObserver(() => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(sweep);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
};

if (!(await Bun.file(FFMPEG).exists())) {
  console.error(
    `shots:readme failed: no ffmpeg at ${FFMPEG}; install it (brew install ffmpeg) or set FFMPEG_PATH`,
  );
  process.exit(1);
}

const telegram = fakeTelegram({ username: "tomte_demo_bot" });
const smoke = await startSmoke("shots-readme", {
  env: { TOMTE_ASK_APPROVAL: "1" },
  timing: {
    telegram: { baseUrl: telegram.url, pollTimeoutSeconds: 2, sendSpacingMs: 0, backoffMs: 50 },
  },
});
const { host, check } = smoke;
const shotContext = (extra: Parameters<typeof smoke.browser.newContext>[0] = {}) =>
  smoke.browser
    .newContext({
      viewport: VIEWPORT,
      timezoneId: "UTC",
      locale: "en-US",
      reducedMotion: "reduce",
      ...extra,
    })
    .then(async (context) => {
      await context.addCookies([
        { name: "tomte_session", value: host.deviceToken, url: host.clientUrl },
      ]);
      await context.addInitScript(fixClocks, STILL);
      return context;
    });
const context = await shotContext();
const page = await context.newPage();

// Demo bots, each with its own purpose, face and chat mode.
const profile = async (
  id: string,
  name: string,
  purpose: string,
  shape: string,
  color: string,
  chiefOfStaff = false,
) => {
  const res = await host.ui("/api/bots/profile", {
    botId: id,
    name,
    purpose,
    shape,
    color,
    chiefOfStaff,
  });
  check(res.ok, `${name} profile saved`);
  return id;
};
const inbox = await profile(
  host.createBot("Inbox"),
  "Inbox",
  "Triages my email, drafts replies and flags what needs me.",
  "ball",
  "coral",
  true,
);
const research = await profile(
  host.createBot("Research"),
  "Research",
  "Digs into questions in the background and writes up what it finds.",
  "gem",
  "violet",
);
const ops = await profile(
  host.createBot("Ops"),
  "Ops",
  "Watches deploys, runs the nightly checks and tells me when something breaks.",
  "hex",
  "teal",
);
check(
  (await host.ui("/api/bots/chat-mode", { botId: research, chatMode: "double_loop" })).ok,
  "Research is a double-loop bot",
);

host.loopScript(...DEMO_SCRIPTS);

// A conversation Inbox already had, from a session file with fixed times.
writeSession(host, inbox, [
  { role: "user", at: T0, text: "Anything from Dana?" },
  {
    role: "assistant",
    at: T0 + 4000,
    text: "Yes: Dana asked to move Thursday's call to 15:00. I checked your calendar and the slot is free. Want me to accept?",
  },
  { role: "user", at: T0 + 60_000, text: "Accept it, and tell her I'll bring the Q3 numbers." },
  {
    role: "assistant",
    at: T0 + 64_000,
    text: "Done. I accepted the new time and told Dana you'll bring the Q3 numbers. Anything else in the inbox?",
  },
]);

// The page, in the viewport the shots use.
const box = page.getByRole("textbox", { name: /^Message / });
/** Opens a bot's chat; `panel` is the section beside it, none closes the panel. */
const open = async (id: string, panel?: string) => {
  await page.evaluate((p) => localStorage.setItem("tomte:panel", p), panel ? "open" : "closed");
  await page.goto(`${host.clientUrl}/bots/${id}${panel === undefined ? "" : `?panel=${panel}`}`);
  await box.waitFor();
  if (panel !== undefined) await page.locator(`[data-panel-section="${panel}"]`).waitFor();
};
const said = (text: string) => page.getByRole("region", { name: "Messages" }).getByText(text);
const say = async (text: string) => {
  await box.fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
};

/** Saves the page as `<name>-light.png` and `<name>-dark.png`, each after the page has followed the colour scheme. */
const shoot = async (name: string) => {
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.waitForFunction(
      (t) => document.documentElement.classList.contains("dark") === (t === "dark"),
      theme,
    );
    await Bun.sleep(400);
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) });
  }
  console.log(`  shot ${name}`);
};

/** The hero animation: Inbox answers one message, recorded from a fresh page and turned into a GIF. */
async function hero() {
  const videos = join(smoke.runDir, "video");
  const recording = await shotContext({
    colorScheme: "light",
    recordVideo: { dir: videos, size: VIEWPORT },
  });
  await recording.addInitScript(() => localStorage.setItem("tomte:panel", "closed"));
  const tab = await recording.newPage();
  const started = Date.now();
  await tab.goto(`${host.clientUrl}/bots/${inbox}`);
  const input = tab.getByRole("textbox", { name: "Message Inbox" });
  await input.waitFor();
  await tab.waitForTimeout(600);
  const from = Math.max(0, (Date.now() - started) / 1000 - 0.4);
  await input.pressSequentially("what needs me today?", { delay: 70 });
  await tab.waitForTimeout(300);
  await tab.getByRole("button", { name: "Send", exact: true }).click();
  await tab
    .getByRole("region", { name: "Messages" })
    .getByText("Want me to send the drafts?")
    .waitFor();
  await tab.waitForTimeout(2000);
  await recording.close();
  const [file] = await readdir(videos);
  check(file !== undefined, "the page was recorded");
  const source = join(videos, file!);
  const palette = join(smoke.runDir, "palette.png");
  const filters = "fps=12,scale=900:-1:flags=lanczos";
  const ffmpeg = (...args: string[]) => {
    const run = Bun.spawnSync([FFMPEG, "-y", "-loglevel", "error", ...args], { stderr: "inherit" });
    check(run.exitCode === 0, `ffmpeg ${args.at(-1)}`);
  };
  ffmpeg("-ss", String(from), "-i", source, "-vf", `${filters},palettegen=max_colors=96`, palette);
  ffmpeg(
    "-ss",
    String(from),
    "-i",
    source,
    "-i",
    palette,
    "-lavfi",
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    join(OUT, "hero.gif"),
  );
  const size = (await stat(join(OUT, "hero.gif"))).size;
  check(size < 3_000_000, `hero.gif is ${(size / 1e6).toFixed(2)} MB`);
}

try {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await page.goto(`${host.clientUrl}/settings`);

  console.log("Research: one finished task, two running");
  await open(research);
  await say("Is pgvector enough at our size?");
  await said(REPORT).waitFor();
  await say("Compare three vector databases for the search feature.");
  await said("On it. I'll compare them and report back.").waitFor();
  await say("Summarize the pricing page changes since March.");
  await said("Looking at the pricing page now.").waitFor();

  console.log("Ops: needs-you items, a routine with a history, the browser switched on");
  const post = eventPoster(await eventAccess(host, ops), {
    id: "deploys",
    label: "Deploy pipeline",
  });
  await post({
    title: "Deploy billing-api 2.4.1 to production?",
    body: "All checks passed on staging. The change touches invoice rounding.",
    options: ["Deploy now", "Wait until tomorrow"],
  });
  await post({
    kind: "failed",
    title: "Nightly backup of the staging database failed",
    body: "The disk is at 98%. The last good backup is from Monday.",
  });
  check((await host.ui("/api/bots/browser", { botId: ops, enabled: true })).ok, "Ops browser on");
  const created = await host.ui("/api/routines/create", {
    botId: ops,
    name: "Nightly deploy check",
    instruction: "Check last night's deploys and tell me if anything was rolled back.",
    schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
  });
  const routine = (await created.json()) as { id: string };
  const succeeded = async () =>
    (
      (await (await host.ui("/api/routines/runs", { id: routine.id })).json()) as {
        status: string;
      }[]
    ).filter((r) => r.status === "succeeded").length;
  for (let n = 1; n <= 3; n++) {
    check((await host.ui("/api/routines/run", { id: routine.id })).ok, `routine run ${n} started`);
    for (let i = 0; i < 400 && (await succeeded()) < n; i++) await Bun.sleep(50);
    check((await succeeded()) === n, `routine run ${n} succeeded`);
  }

  console.log("Telegram: link the owner's account");
  await page.goto(`${host.clientUrl}/settings/channels`);
  await page.getByLabel("Bot token").fill(telegram.token);
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByText(`Running as @${telegram.username}`).waitFor();
  await host.until(() => telegram.of("getUpdates").length > 0);
  await page.getByRole("button", { name: "Link account" }).click();
  const dialog = page.getByRole("dialog");
  const code = (await dialog.locator("code").textContent())!;
  telegram.message({ id: 4242, first_name: "Maya", last_name: "Lindqvist" }, `/start ${code}`);
  await host.until(() => telegram.texts().some((t) => t.startsWith("Linked.")));
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByText("Maya Lindqvist · linked").waitFor();
  await shoot("channels");

  console.log("the other shots");
  await open(inbox);
  await said("Done. I accepted the new time").waitFor();
  await shoot("chat");
  await open(research, "tasks");
  await page.locator("[data-task]").first().waitFor();
  await shoot("tasks");
  await open(ops, "work");
  await page
    .getByRole("button", { name: /Needs you/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Deploy now" }).first().waitFor();
  await shoot("work");
  await open(ops, "routines");
  await page.getByText("Run history").click();
  await page.getByText("test run").nth(1).click();
  await page.getByText("3 of 4 deploys green").first().waitFor();
  await shoot("routines");
  await open(ops, "browser");
  await shoot("browser");
  await open(inbox, "profile");
  await page.locator("[data-chief-of-staff]").first().waitFor();
  await shoot("chief-of-staff");
  await open(inbox);
  await page.getByRole("button", { name: "Model and chat" }).click();
  await page.getByRole("radio", { name: /^Double loop/ }).waitFor();
  await shoot("model-chip");

  console.log("hero.gif");
  await hero();
  await smoke.pass();
} catch (e) {
  await page
    .screenshot({ path: join(smoke.runDir, "failure-shots-page.png") })
    .catch(() => undefined);
  await smoke.fail(e);
} finally {
  await context.close().catch(() => undefined);
  await telegram.stop();
}
