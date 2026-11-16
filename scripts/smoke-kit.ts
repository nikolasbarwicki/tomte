// Shared harness of the browser smokes (smoke-answer-ui, smoke-needs-you-ui, smoke-blocked-ui, smoke-answers, smoke-loop-ui).
// A smoke gets a fresh run directory under the OS temp folder, a web build in it (or the one named by SMOKE_WEB_DIST, which the
// wrapper smoke-ui.ts builds once), the whole-host test harness (temporary data root, in-memory database and secrets, fake
// Claude CLI), and headless Chrome in a fresh profile with the paired device's cookie. Nothing touches real app data, the
// default data root, a real model, a real coordinator or the OS.
//
// A smoke is `const smoke = await startSmoke("name")`, a `try` block of `smoke.check(...)` calls, `await smoke.pass()` at its end and
// `await smoke.fail(e)` in the `catch`. `pass()` removes the run directory (set SMOKE_KEEP=1 to keep it). `fail()` keeps it and prints
// its path with: `checks.log` (every step and check), `page-console.log` (console, page errors and failed requests of every page),
// `host.log` (what the host wrote to stderr), a screenshot of every open page, `error.txt`, and whatever the smoke put in the
// directory itself (recorded argument lists, for one), and sets a non-zero exit code. Nothing but the run directory and the
// processes this harness started is ever removed or stopped.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

import type { EventAccess } from "@claudebot/contract/api";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { startHandoffHost, type HandoffHost } from "../packages/host/src/testing/test-host.ts";
import { directoryAssets } from "../packages/host/src/ui/index.ts";

const ROOT = join(import.meta.dir, "..");
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** The sender program, run by its path as a script would run it. */
const SENDER = join(ROOT, "packages/notify/src/main.ts");

/** Builds the web UI into `outDir`; throws when the build fails. */
export function buildWeb(outDir: string) {
  const build = Bun.spawnSync(
    ["bun", "x", "vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
    { cwd: join(ROOT, "packages/web"), stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) throw new Error("smoke failed: the web build failed");
}

export interface Smoke {
  host: HandoffHost;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Holds everything this run writes; kept on failure. */
  runDir: string;
  pageErrors: string[];
  /** Throws, naming the check, unless `ok`. */
  check: (ok: boolean, message: string) => void;
  /** Saves a screenshot of `page` as `shots/<name>.png` in the run directory. */
  shot: (name: string, page?: Page) => Promise<void>;
  /** Another page of the same browser profile, as a second tab of the same device. */
  newPage: () => Promise<Page>;
  /** Closes everything and removes the run directory (kept with SMOKE_KEEP=1). */
  pass: () => Promise<void>;
  /** Keeps the run directory with its artifacts, prints where, and sets a non-zero exit code. */
  fail: (error: unknown) => Promise<void>;
}

export interface SmokeOptions {
  /** Host flags, from the run directory (a relay configuration file lives in it). */
  hostFlags?: (runDir: string) => string[] | Promise<string[]>;
  /** The environment the host's configuration is read from, such as `CLAUDEBOT_ASK_APPROVAL`; the process environment is left alone. */
  env?: Record<string, string>;
}

interface Session {
  host: HandoffHost;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function startSmoke(name: string, options: SmokeOptions = {}): Promise<Smoke> {
  const sharedDist = process.env.SMOKE_WEB_DIST;
  const runDir = await mkdtemp(join(tmpdir(), `claudebot-smoke-${name}-`));
  const checks: string[] = [];
  const pageLog: string[] = [];
  const hostLog: string[] = [];
  const pageErrors: string[] = [];
  // Every line the smoke prints is kept for checks.log, and the host's own stderr for host.log.
  const log = console.log;
  const hostError = console.error;
  console.log = (...args: unknown[]) => {
    checks.push(format(...args));
    log(...args);
  };
  console.error = (...args: unknown[]) => {
    hostLog.push(format(...args));
    hostError(...args);
  };
  const restoreConsole = () => {
    console.log = log;
    console.error = hostError;
  };

  let host: HandoffHost | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const closeAll = async () => {
    restoreConsole();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await host?.stop().catch(() => undefined);
  };
  const start = async (): Promise<Session> => {
    if (!(await Bun.file(CHROME).exists()))
      throw new Error(`smoke failed: no browser at ${CHROME}; set CHROME_PATH`);
    process.env.CLAUDE_CONFIG_DIR = join(runDir, "claude-config");
    const dist = sharedDist ?? join(runDir, "web");
    if (sharedDist === undefined) buildWeb(dist);
    const flags = (await options.hostFlags?.(runDir)) ?? [];
    const startedHost = await startHandoffHost(
      flags,
      directoryAssets(dist),
      undefined,
      undefined,
      options.env,
    );
    host = startedHost;
    const startedBrowser = await chromium.launch({ executablePath: CHROME, headless: true });
    browser = startedBrowser;
    const startedContext = await startedBrowser.newContext({
      viewport: { width: 1400, height: 900 },
    });
    context = startedContext;
    await startedContext.addCookies([
      { name: "claudebot_session", value: startedHost.deviceToken, url: startedHost.clientUrl },
    ]);
    let pages = 0;
    const watch = (p: Page) => {
      const id = `page${++pages}`;
      p.setDefaultTimeout(8000);
      p.on("console", (m) => pageLog.push(`[${id}] console.${m.type()}: ${m.text()}`));
      p.on("pageerror", (e) => {
        pageErrors.push(String(e));
        pageLog.push(`[${id}] pageerror: ${String(e)}`);
      });
      p.on("requestfailed", (r) =>
        pageLog.push(`[${id}] requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`),
      );
    };
    startedContext.on("page", watch);
    return {
      page: await startedContext.newPage(),
      context: startedContext,
      host: startedHost,
      browser: startedBrowser,
    };
  };
  let session: Session;
  try {
    session = await start();
  } catch (e) {
    await closeAll();
    console.error(`smoke ${name} could not start; run directory kept at ${runDir}`);
    await writeFile(join(runDir, "error.txt"), String((e as Error).stack ?? e));
    throw e;
  }
  const { page } = session;
  let shots = 0;

  const smoke: Smoke = {
    host: session.host,
    browser: session.browser,
    context: session.context,
    page,
    runDir,
    pageErrors,
    check(ok, message) {
      if (!ok) throw new Error(`smoke failed: ${message}`);
      console.log(`  ok: ${message}`);
    },
    async shot(shotName, target = page) {
      await mkdir(join(runDir, "shots"), { recursive: true });
      await target.screenshot({
        path: join(runDir, "shots", `${String(++shots).padStart(2, "0")}-${shotName}.png`),
      });
    },
    newPage: () => session.context.newPage(),
    async pass() {
      await closeAll();
      console.log(`${name} smoke passed`);
      if (process.env.SMOKE_KEEP === "1") {
        await writeFile(join(runDir, "checks.log"), checks.join("\n") + "\n");
        await writeFile(join(runDir, "page-console.log"), pageLog.join("\n") + "\n");
        await writeFile(join(runDir, "host.log"), hostLog.join("\n") + "\n");
        console.log(`run directory kept at ${runDir}`);
      } else await rm(runDir, { recursive: true, force: true });
    },
    async fail(error) {
      const text = String((error as Error)?.stack ?? error);
      for (const [i, p] of session.context.pages().entries())
        await p
          .screenshot({ path: join(runDir, `failure-page${i + 1}.png`) })
          .catch(() => undefined);
      await writeFile(join(runDir, "checks.log"), checks.join("\n") + "\n");
      await writeFile(join(runDir, "page-console.log"), pageLog.join("\n") + "\n");
      await writeFile(join(runDir, "host.log"), hostLog.join("\n") + "\n");
      await writeFile(join(runDir, "error.txt"), text + "\n");
      await closeAll();
      if (sharedDist === undefined) await rm(join(runDir, "web"), { recursive: true, force: true });
      console.error(text);
      console.error(`smoke ${name} FAILED; artifacts kept at ${runDir}`);
      process.exitCode = 1;
    },
  };
  return smoke;
}

/** The bot's events route and token, as the page's "events" panel would hand them out. */
export async function eventAccess(host: HandoffHost, botId: string) {
  return (await (await host.ui("/api/bots/events-token", { botId })).json()) as EventAccess;
}

/** Posts one event to a bot's route as an outside program would; returns the host's id for it. */
export function eventPoster(
  access: EventAccess,
  source = { id: "coordinator", label: "Coordinator" },
) {
  let seq = 0;
  return async (
    body: { title: string; kind?: string; options?: string[] } & Record<string, unknown>,
  ) => {
    const res = await fetch(access.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access.token}` },
      body: JSON.stringify({ kind: "question", key: `q${++seq}`, source, ...body }),
    });
    if (res.status !== 202)
      throw new Error(`event post answered ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
  };
}

/** The real sender program as a subprocess with only the bot's route in its environment; returns what it printed and its exit code. */
export async function runNotify(
  access: EventAccess,
  home: string,
  argv: string[],
  env: Record<string, string> = {},
) {
  const child = Bun.spawn([process.execPath, SENDER, ...argv], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAUDEBOT_EVENTS_URL: access.url,
      CLAUDEBOT_EVENTS_TOKEN: access.token,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out: stdout.trim(), err: stderr.trim(), code };
}

interface SendCall {
  body: { text: string; eventId?: string; answer?: string };
  status?: number | undefined;
  json?: { outcome?: string; queued?: string; error?: string };
}
/** Every `/api/send` and `/api/answer` the page makes, with what the host answered. */
export function recordRequests(page: Page) {
  const sends: SendCall[] = [];
  const answers: { body: { id?: string; value?: string }; status?: number | undefined }[] = [];
  page.on("requestfinished", async (req) => {
    const url = req.url();
    if (!url.endsWith("/api/send") && !url.endsWith("/api/answer")) return;
    const res = await req.response();
    if (url.endsWith("/api/answer"))
      answers.push({ body: JSON.parse(req.postData() ?? "{}"), status: res?.status() });
    else
      sends.push({
        body: JSON.parse(req.postData() ?? "{}"),
        status: res?.status(),
        json: await res?.json().catch(() => undefined),
      });
  });
  return { sends, answers };
}

/** The Needs you bar, the composer and the badges of one bot's page. */
export function needsYouView(page: Page, botName: string) {
  const bar = page.getByRole("region", { name: "Needs you", exact: true });
  const box = page.getByRole("textbox", { name: `Message ${botName}`, exact: true });
  const badges = () =>
    page
      .locator("[data-needs-you]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-needs-you")));
  // The bar can detach between the count and the read, when the last item closes.
  const needsYou = async () =>
    Number(
      (await bar
        .locator("span.tabular-nums")
        .first()
        .innerText({ timeout: 250 })
        .catch(() => "0")) || 0,
    );
  const settled = async (open: number) => {
    for (let i = 0; i < 100; i++) {
      if ((await needsYou()) === open && (await badges()).every((b) => b === String(open))) return;
      await Bun.sleep(50);
    }
    throw new Error(
      `smoke failed: expected ${open} open items, the bar shows ${await needsYou()}, badges ${JSON.stringify(await badges())}`,
    );
  };
  const expand = async () => {
    if (!(await bar.locator("ul").count()))
      await bar.getByRole("button", { name: /Needs you/ }).click();
  };
  const item = (title: string) => bar.locator("li", { hasText: title });
  return { bar, box, badges, needsYou, settled, expand, item };
}
