import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Smoke test for the packaged desktop app on this machine, run for real through playwright-core:
//   bun scripts/smoke-desktop.ts [dist/desktop/Claudebot-darwin-arm64/Claudebot.app]   (default: this machine's package output)
// Launches the packaged `.app` binary (`bun run package:desktop` builds it) on a fresh temporary root that holds the
// data root, the Electron user-data directory and the file-secrets key, with Chromium's mock keychain, so nothing
// reaches the macOS keychain or a default folder. Three launches on that root:
//   1. first launch with no CLAUDE_PATH and no `claude` on PATH, so the host installs the managed Claude CLI (needs network);
//   2. a fake CLAUDE_PATH: signed-in UI, renderer isolation, navigation policy, the UI's OAuth connect against a loopback
//      fixture, a running bot turn, then `kill -9` of the Electron main process;
//   3. background (DESK-03): closing the window leaves the host running and a routine fires; the tray's state and menu
//      handlers; the host killed alone and restarted from the tray; the tray's Quit with a real engine and Chrome running;
//   4. relaunch on the same data root started with `--hidden`, then a graceful `app.quit()`.
// Start at login is recorded through CLAUDEBOT_DESKTOP_LOGIN_ITEM_FILE (a file, not the OS: nothing is ever registered).
// The tray and its menu are read from the main process (`process.mainModule.exports.desktop`), and menu items are
// invoked by calling the same `click` handler the real menu calls; the menu bar itself is not clicked.
// After each end it checks that no process from the run remains. Never prints a token, cookie value or pairing code.
// Stubs and fakes are labeled where they are used: the fake Claude CLI, the OAuth fixture, and `shell.openExternal`
// wrapped to record calls (the last hop to the OS is then a stub; with SMOKE_SYSTEM_BROWSER=1 one separate call is
// left real and opens a tab in the default browser).
import { oauthFixture } from "../packages/host/src/testing/fake-oauth-server.ts";
import {
  CLIENT_URL,
  EVIDENCE_DIR,
  FAKE_CLAUDE,
  FIRST_LAUNCH_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  alive,
  check,
  clickTray,
  createSmokeRun,
  defaultFolders,
  describeProcess,
  fail,
  info,
  leftovers,
  libraryTraces,
  listing,
  processes,
  sleep,
  trayView,
  until,
} from "./desktop-smoke-kit.ts";

async function main(): Promise<void> {
  const {
    appBundle,
    root,
    needles,
    dataRoot,
    fakeStateDir,
    fakeCli,
    launched,
    launch,
    devices,
    hostOf,
    gone,
    launchEnv,
    nothingRemains,
    hostLog,
    quit,
    cleanup,
    settingsFile,
    loginItemFile,
  } = await createSmokeRun(process.argv[2], "claudebot-desktop-smoke-");

  const landing: { url: string; userAgent: string }[] = [];
  const landingServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      landing.push({
        url: new URL(req.url).pathname,
        userAgent: req.headers.get("user-agent") ?? "",
      });
      return new Response(
        "<title>claudebot desktop smoke</title>fixture reached; you can close this tab",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  const oauth = oauthFixture();
  const beforeDefaults = defaultFolders.map((d) => [d, listing(d)] as const);
  const beforeTraces = libraryTraces();
  console.log(`temp root ${root}`);
  console.log(`app       ${appBundle}`);

  try {
    // ---- 1. first launch, managed CLI install ------------------------------------------------------------------
    console.log("\n[1] first launch on a fresh data root, managed Claude CLI install (network)");
    const run1Started = Date.now();
    const first = await launch({ PATH: "/usr/bin:/bin" }, FIRST_LAUNCH_TIMEOUT_MS);
    info(
      `window reached ${first.clientUrl} after ${((Date.now() - run1Started) / 1000).toFixed(1)}s`,
    );
    const host1 = hostOf(first.pid) ?? fail("no host process is a child of the app");
    info(`app    ${describeProcess(processes().find((p) => p.pid === first.pid)!)}`);
    info(`host   ${describeProcess(host1)}`);
    check(
      host1.tty === "??",
      "the host has no controlling terminal and is a child of the app process",
    );
    const marker = join(dataRoot, "claude-cli/current");
    const managed = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    check(
      managed !== "" && existsSync(managed),
      `the host installed the managed Claude CLI into the data root (${managed.replace(root, "<root>")})`,
    );
    const list1 = await devices(first.page);
    check(list1.status === 200, "fetch /api/devices/list in the page answers 200");
    check(
      list1.body.length === 1 && list1.body[0]!.name === "This computer" && list1.body[0]!.current,
      'the signed-in device is "This computer" and current',
    );
    await sleep(1500);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const shot = join(root, "ui-signed-in.png");
    await first.page.screenshot({ path: shot });
    await copyFile(shot, join(EVIDENCE_DIR, "desktop-ui-signed-in.png"));
    info(
      `screenshot kept at .scratch/desktop-ui-signed-in.png (title: ${await first.page.title()})`,
    );
    const id1 = list1.body[0]!.id;
    console.log(
      "  Start at login after the first launch (the login-item file is the seam; the OS is never asked)",
    );
    check(
      JSON.stringify(readJson(settingsFile)) === '{"startAtLogin":true}',
      "settings.json says startAtLogin: true, written by the first launch",
    );
    check(
      JSON.stringify(readJson(loginItemFile)) === '{"openAtLogin":true}',
      "the login item was set: the seam file records openAtLogin: true",
    );
    await quit(first);
    await nothingRemains("launch 1");

    console.log("\n[1b] install the managed browser engine into the temp data root (network)");
    const installed = Bun.spawnSync(
      [
        join(appBundle, "Contents/Resources/claudebot-host"),
        "install-browser",
        "--data-root",
        dataRoot,
      ],
      { env: launchEnv({}), stdout: "pipe", stderr: "pipe" },
    );
    check(
      installed.exitCode === 0,
      `the packaged host's install-browser exited 0: ${installed.stdout.toString().trim().replaceAll(root, "<root>")}`,
    );

    // ---- 2. fake CLI: isolation, navigation, OAuth, crash --------------------------------------------------------
    console.log(
      "\n[2] launch with the fake Claude CLI (stub): isolation, navigation, OAuth, kill -9",
    );
    const second = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS);
    const list2 = await devices(second.page);
    check(
      list2.status === 200 &&
        list2.body.length === 1 &&
        list2.body[0]!.current &&
        list2.body[0]!.id !== id1,
      "a relaunch on the same data root replaced the earlier launch device (one device, a new id)",
    );

    const prefs = await second.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      const p = w.webContents.getLastWebPreferences()!;
      return {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
        webviewTag: p.webviewTag,
        preload: p.preload ?? null,
        windows: BrowserWindow.getAllWindows().length,
      };
    });
    info(`webPreferences ${JSON.stringify(prefs)}`);
    check(
      prefs.contextIsolation === true &&
        prefs.sandbox === true &&
        prefs.nodeIntegration === false &&
        prefs.webviewTag === false &&
        prefs.preload === null,
      "webPreferences: contextIsolation, sandbox on; nodeIntegration, webviewTag off; no preload",
    );
    // Asked over raw CDP: Playwright's own evaluate wrapper defines a `require` in the function it runs, which says nothing about the page.
    const cdp = await second.page.context().newCDPSession(second.page);
    const globals: string[] = [];
    for (const name of ["process", "require", "module", "Buffer"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: `typeof ${name}` });
      globals.push(String(result.value));
    }
    check(
      globals.every((g) => g === "undefined"),
      `the renderer has no Node: typeof process/require/module/Buffer = ${globals.join("/")} (raw CDP Runtime.evaluate)`,
    );
    const cookie = await second.app.evaluate(async ({ session }) => {
      const found = await session.defaultSession.cookies.get({ name: "claudebot_session" });
      return found.map((c) => ({
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        secure: c.secure,
        session: c.session,
        domain: c.domain,
        valueLength: c.value.length,
      }));
    });
    info(`session cookie (value withheld) ${JSON.stringify(cookie)}`);
    check(
      cookie.length === 1 &&
        cookie[0]!.httpOnly &&
        cookie[0]!.sameSite === "strict" &&
        cookie[0]!.session,
      "the session cookie is HttpOnly, SameSite=Strict and a session cookie (no expiry, never persisted)",
    );
    const denied = await second.page.evaluate(async () => {
      const geolocation = await new Promise((res) =>
        navigator.geolocation.getCurrentPosition(
          () => res("granted"),
          (e) => res(`denied (code ${e.code})`),
        ),
      );
      return { geolocation, notifications: await Notification.requestPermission() };
    });
    check(
      String(denied.geolocation).startsWith("denied") && denied.notifications === "denied",
      `permission requests are denied: geolocation ${String(denied.geolocation)}, notifications ${denied.notifications}`,
    );

    // The recorder replaces shell.openExternal with a stub; the hop to the OS browser is not exercised until "real" below.
    await second.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { opened: string[]; realOpen: unknown };
      g.opened = [];
      g.realOpen = shell.openExternal.bind(shell);
      shell.openExternal = async (url: string) => void g.opened.push(url);
    });
    const opened = () =>
      second.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);
    const startUrl = second.page.url();

    console.log("  navigation (shell.openExternal is a recording stub here)");
    await second.page.evaluate(() => void (location.href = "https://cross-origin.example/nav?x=1"));
    await until("the cross-origin navigation to reach openExternal", 5000, async () =>
      (await opened()).includes("https://cross-origin.example/nav?x=1"),
    );
    await sleep(300);
    check(
      second.page.url() === startUrl,
      "a cross-origin location change is blocked: the window stays on the client URL",
    );
    check(true, "...and was handed to openExternal as https://cross-origin.example/nav?x=1");
    const before = (await opened()).length;
    await second.page.evaluate(() => void (location.href = "file:///etc/hosts"));
    await sleep(500);
    check(
      second.page.url() === startUrl && (await opened()).length === before,
      "a file: navigation is blocked and not handed to the system browser",
    );

    const openResults = await second.page.evaluate(() => ({
      crossOrigin: window.open("https://cross-origin.example/open", "_blank") === null,
      blank: window.open("about:blank", "_blank") === null,
      empty: window.open("", "_blank") === null,
      sameOrigin: window.open("/integrations", "_blank") === null,
    }));
    await sleep(300);
    const afterOpen = await opened();
    check(
      Object.values(openResults).every(Boolean),
      `window.open returns null for every target: ${JSON.stringify(openResults)}`,
    );
    check(
      afterOpen.length === before + 1 && afterOpen.at(-1) === "https://cross-origin.example/open",
      "only the cross-origin window.open reached openExternal; about:blank, empty and same-origin targets opened nothing",
    );
    await second.page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "https://cross-origin.example/link";
      a.target = "_blank";
      document.body.append(a);
      a.click();
    });
    await until("the target=_blank link to reach openExternal", 5000, async () =>
      (await opened()).includes("https://cross-origin.example/link"),
    );
    check(true, "a target=_blank link to another origin reaches openExternal");
    check(
      (await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) ===
        1,
      "no second window was ever created",
    );

    console.log("  OAuth connect through the UI (loopback fixture provider, openExternal stub)");
    const openedBefore = (await opened()).length;
    await second.page.goto(`${second.clientUrl}integrations`);
    await second.page.getByRole("button", { name: "Add custom" }).click();
    await second.page.locator("#custom-name").fill("fixture");
    await second.page.locator("#custom-url").fill(oauth.url);
    await second.page.getByRole("switch", { name: "Sign in with OAuth" }).click();
    await second.page.getByRole("button", { name: "Add server" }).click();
    const authorize = await until("the authorize URL to reach openExternal", 30_000, async () =>
      (await opened())
        .slice(openedBefore)
        .find((u) => u.startsWith(`${new URL(oauth.url).origin}/authorize`)),
    );
    const authorizeUrl = new URL(authorize);
    check(
      (await opened()).length === openedBefore + 1,
      "the blank window.open the UI makes first was refused, and only window.open(authorizeUrl) reached openExternal",
    );
    info(
      `openExternal(${authorizeUrl.origin}${authorizeUrl.pathname}?${[...authorizeUrl.searchParams.keys()].join("&")}) [stub]`,
    );
    check(
      authorizeUrl.searchParams.get("response_type") === "code" &&
        authorizeUrl.searchParams.has("code_challenge"),
      "it is the fixture provider's authorize URL with a PKCE challenge",
    );

    if (process.env.SMOKE_SYSTEM_BROWSER === "1") {
      console.log("  one real shell.openExternal to a loopback fixture");
      const landingUrl = `http://127.0.0.1:${landingServer.port}/system-browser`;
      await second.app.evaluate(({ shell }, url) => {
        const g = globalThis as unknown as { realOpen: typeof shell.openExternal };
        shell.openExternal = g.realOpen;
        return shell.openExternal(url);
      }, landingUrl);
      const hit = await until("the system browser to request the fixture", 30_000, () =>
        landing.find((l) => l.url === "/system-browser"),
      );
      info(`fixture saw GET ${hit.url} with user agent: ${hit.userAgent}`);
      check(
        !/electron/i.test(hit.userAgent) && hit.userAgent.length > 0,
        "the request came from the system browser, not from Electron",
      );
    } else {
      info("real system-browser hop skipped (set SMOKE_SYSTEM_BROWSER=1; it opens a tab)");
    }

    console.log(
      "  a running bot turn with the browser on: a Claude CLI child, the engine and Chrome exist when the app dies",
    );
    await writeFile(join(fakeStateDir, "hold"), "");
    const sent = await second.page.evaluate(async () => {
      const post = (path: string, body: object) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const created = await post("/api/bots/new", {
        name: "smoke",
        purpose: "",
        face: "tuft",
        stroke: "ink",
      });
      const bot = created.ok ? ((await created.json()) as { id: string }) : undefined;
      const enabled = bot
        ? await post("/api/bots/browser", { botId: bot.id, enabled: true })
        : created;
      const send = enabled.ok ? await post("/api/send", { text: "hold the turn open" }) : enabled;
      return [created.status, enabled.status, send.status];
    });
    check(
      sent.every((s) => s === 200),
      `a bot was created, its browser turned on and a message sent (statuses ${sent.join(", ")})`,
    );
    const cli = await until("the fake Claude CLI child", 30_000, () =>
      processes().find((p) => p.command.includes(FAKE_CLAUDE) && p.command.includes(fakeStateDir)),
    );
    info(`cli    ${describeProcess(cli)}`);
    const engine2 = await startEngine(fakeStateDir, needles, landingServer.port);

    console.log("\n[5] crash cleanup: kill -9 of the Electron main process");
    const host2 = hostOf(second.pid) ?? fail("no host process is a child of the app");
    info(`kill -9 ${second.pid}; host is pid ${host2.pid}, Claude CLI pid ${cli.pid}`);
    process.kill(second.pid, "SIGKILL");
    const hostMs = await gone(host2.pid, "the host");
    check(true, `the host exited ${(hostMs / 1000).toFixed(1)}s after the app was killed`);
    const cliMs = await gone(cli.pid, "the Claude CLI child");
    check(
      true,
      `the Claude CLI child was gone ${(cliMs / 1000).toFixed(1)}s after the app was killed`,
    );
    await until(
      "the engine and Chrome to be gone",
      30_000,
      () => engineProcesses(needles).length === 0,
    );
    check(
      true,
      `none of the ${engine2.length} engine and Chrome processes seen before the kill remain (${engine2.map((p) => p.pid).join(" ")})`,
    );
    await nothingRemains("the killed launch");

    // ---- 3. background: tray, close to tray, routine, restart, Quit ----------------------------------------------
    console.log(
      "\n[3] background (DESK-03): close to tray, a routine fires, tray menu, host restart, tray Quit",
    );
    await rm(join(fakeStateDir, "hold"), { force: true });
    await rm(join(fakeStateDir, "messages.jsonl"), { force: true });
    await rm(join(fakeStateDir, "launches.jsonl"), { force: true });
    const bg = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS);
    const bgHost = hostOf(bg.pid) ?? fail("no host process is a child of the app");
    const view0 = await trayView(bg);
    info(`tray   ${JSON.stringify(view0)}`);
    check(
      view0.status === "running" &&
        view0.tooltip === "Claudebot: host running" &&
        view0.items[0]!.label === view0.tooltip &&
        !view0.items[0]!.enabled,
      'the tray tooltip and its first, disabled item say "Claudebot: host running"',
    );
    check(
      view0.items.map((i) => i.label).join("|") ===
        `${view0.tooltip}||This computer||Manage Connections…||Open Claudebot|Start at login||Quit Claudebot`,
      "the menu is: state, separator, This computer, separator, Manage Connections…, separator, Open Claudebot, Start at login, separator, Quit Claudebot",
    );
    check(
      view0.items.find((i) => i.label === "This computer")?.checked === true,
      "the tray lists This computer as the checked connection (no remote profile exists in this smoke)",
    );
    check(
      view0.items.find((i) => i.label === "Start at login")?.checked === true,
      "the Start at login checkbox is checked",
    );

    console.log(
      "  close to tray, with a routine due in ~20s (a `once` schedule; cron has minute granularity)",
    );
    const setup = await bg.page.evaluate(async (at) => {
      const post = (path: string, body: object) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json() as Promise<{ id: string }>);
      const bot = await post("/api/bots/new", {
        name: "ticker",
        purpose: "",
        face: "tuft",
        stroke: "ink",
      });
      const routine = await post("/api/routines/create", {
        botId: bot.id,
        name: "tray routine",
        instruction: "say ok",
        schedule: { kind: "once", at },
      });
      return { botId: bot.id, routineId: routine.id };
    }, Date.now() + 20_000);
    const closedAt = Date.now();
    await bg.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    // The dock icon goes a moment after the window does.
    const closed = await until(
      "the window to be hidden and the dock icon gone",
      10_000,
      async () => {
        const v = await trayView(bg);
        return !v.visible && !v.dock && v;
      },
    ).catch(() => trayView(bg));
    check(
      closed.windows === 1 && !closed.visible && !closed.dock,
      `BrowserWindow.close() hid the window instead of closing it (windows ${closed.windows}, visible ${closed.visible}, dock icon visible ${closed.dock})`,
    );
    check(
      alive(bg.pid) && alive(bgHost.pid) && closed.status === "running",
      `the app (pid ${bg.pid}) and the host (pid ${bgHost.pid}) are still alive, the tray says running`,
    );
    const run = await until("the routine to run with the window closed", 90_000, async () =>
      (
        await bg.page.evaluate(async (id) => {
          const r = await fetch("/api/routines/runs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
          return (await r.json()) as { status: string; startedAt: number; trigger: string }[];
        }, setup.routineId)
      ).find((r) => r.status !== "running"),
    );
    check(
      run.status === "succeeded" && run.trigger === "schedule" && run.startedAt > closedAt,
      `the routine ran by its schedule ${((run.startedAt - closedAt) / 1000).toFixed(1)}s after the window was closed and ${run.status}`,
    );
    const prompts = existsSync(join(fakeStateDir, "messages.jsonl"))
      ? readFileSync(join(fakeStateDir, "messages.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { text: string }).text)
      : [];
    check(
      prompts.some((p) =>
        p.startsWith('<scheduled-routine name="tray routine" trigger="schedule"'),
      ),
      "the fake Claude CLI received the scheduled routine's prompt",
    );
    check(
      alive(bgHost.pid) && !(await trayView(bg)).visible,
      "the host is still alive and the window is still hidden after the run",
    );

    console.log(
      "  tray menu handlers (invoked by calling the items' click, not by clicking the menu bar)",
    );
    await clickTray(bg, "Open Claudebot");
    await until("the window and the dock icon to show", 10_000, async () => {
      const v = await trayView(bg);
      return v.visible && v.dock;
    });
    const opened2 = await trayView(bg);
    check(
      opened2.windows === 1 && opened2.dock && CLIENT_URL.test(bg.page.url()),
      `"Open Claudebot" showed the same window (windows ${opened2.windows}, dock icon visible ${opened2.dock}) on the client URL`,
    );
    const deviceBefore = (await devices(bg.page)).body[0]!.id;
    info(`kill -9 the host alone (pid ${bgHost.pid})`);
    process.kill(bgHost.pid, "SIGKILL");
    const stoppedView = await until("the tray to show stopped", 15_000, async () => {
      const v = await trayView(bg);
      return v.status === "stopped" && v;
    });
    check(
      stoppedView.tooltip === "Claudebot: host stopped" &&
        stoppedView.items[0]!.label === "Claudebot: host stopped" &&
        stoppedView.items.some((i) => i.label === "Restart host" && i.enabled),
      'the tray switched to "Claudebot: host stopped" and offers Restart host',
    );
    check(
      (await bg.page.textContent("body"))?.includes("host is not running") === true,
      "the window shows that the host is not running",
    );
    await clickTray(bg, "Restart host");
    await until(
      "the tray to show running again",
      120_000,
      async () => (await trayView(bg)).status === "running",
    );
    await bg.page.waitForURL(CLIENT_URL, { timeout: 60_000 });
    const bgHost2 =
      hostOf(bg.pid) ?? fail("no host process is a child of the app after the restart");
    const afterRestart = await devices(bg.page);
    check(
      bgHost2.pid !== bgHost.pid &&
        (await trayView(bg)).items.every((i) => i.label !== "Restart host") &&
        afterRestart.status === 200 &&
        afterRestart.body.length === 1 &&
        afterRestart.body[0]!.current &&
        afterRestart.body[0]!.id !== deviceBefore,
      `"Restart host" started a new host (pid ${bgHost2.pid}); the tray says running and the window is signed in with a fresh launch token (new device id)`,
    );

    console.log("  a real engine and Chrome again, then Start at login off and the tray's Quit");
    await writeFile(join(fakeStateDir, "hold"), "");
    const sent2 = await bg.page.evaluate(async (botId) => {
      const post = (path: string, body: object) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const opened = await post("/api/open", { botId });
      const enabled = await post("/api/bots/browser", { botId, enabled: true });
      const send = await post("/api/send", { text: "hold the turn open" });
      return [opened.status, enabled.status, send.status];
    }, setup.botId);
    check(
      sent2.every((s) => s === 200),
      `the bot was opened, its browser turned on and a message sent (statuses ${sent2.join(", ")})`,
    );
    const cli3 = await until("the fake Claude CLI child", 30_000, () =>
      processes().find((p) => p.command.includes(FAKE_CLAUDE) && p.command.includes(fakeStateDir)),
    );
    info(`cli    ${describeProcess(cli3)}`);
    const engine3 = await startEngine(fakeStateDir, needles, landingServer.port);

    await clickTray(bg, "Start at login");
    check(
      JSON.stringify(readJson(settingsFile)) === '{"startAtLogin":false}' &&
        JSON.stringify(readJson(loginItemFile)) === '{"openAtLogin":false}' &&
        (await trayView(bg)).items.find((i) => i.label === "Start at login")?.checked === false,
      'the "Start at login" handler wrote false to settings.json and to the login-item seam file, and the checkbox is unchecked',
    );

    const bgProc = bg.app.process();
    const bgExit = new Promise<number | null>((res) => bgProc.once("exit", (code) => res(code)));
    const bgHostGone = gone(bgHost2.pid, "the host after the tray's Quit");
    const bgCliGone = gone(cli3.pid, "the Claude CLI child after the tray's Quit");
    await clickTray(bg, "Quit Claudebot").catch(() => {});
    const bgCode = await Promise.race([bgExit, sleep(60_000).then(() => "timeout" as const)]);
    check(bgCode === 0, `the tray's Quit ended the app with exit code ${bgCode}`);
    info(
      `the host exited ${(((await bgHostGone) as number) / 1000).toFixed(1)}s and the Claude CLI child ${(((await bgCliGone) as number) / 1000).toFixed(1)}s after Quit`,
    );
    const bgExits = hostLog()
      .split("\n")
      .filter((l) => l.includes("[desktop] host exited"));
    check(
      bgExits.at(-1)?.endsWith("host exited (0)") === true,
      `the app log records the host exiting with code 0 (${bgExits.at(-1)?.slice(25)})`,
    );
    await until(
      "the engine and Chrome to be gone",
      30_000,
      () => engineProcesses(needles).length === 0,
    );
    check(
      true,
      `none of the ${engine3.length} engine and Chrome processes seen before Quit remain (${engine3.map((p) => p.pid).join(" ")})`,
    );
    await nothingRemains("the launch quit from the tray");

    // ---- 3. relaunch + graceful quit -----------------------------------------------------------------------------
    console.log(
      "\n[6] relaunch on the same data root with --hidden, Start at login stays off, graceful quit",
    );
    await rm(join(fakeStateDir, "hold"), { force: true });
    const third = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS, ["--hidden"]);
    const hiddenView = await trayView(third);
    check(
      hiddenView.status === "running" && !hiddenView.visible && !hiddenView.dock,
      `an app started with --hidden (the login item's flag) has no visible window and no dock icon, and its tray says running`,
    );
    check(
      JSON.stringify(readJson(settingsFile)) === '{"startAtLogin":false}' &&
        JSON.stringify(readJson(loginItemFile)) === '{"openAtLogin":false}' &&
        hiddenView.items.find((i) => i.label === "Start at login")?.checked === false,
      "the relaunch kept Start at login off: settings.json, the seam file and the checkbox all say false",
    );
    await clickTray(third, "Open Claudebot");
    await until("the window to be visible", 10_000, async () => (await trayView(third)).visible);
    check(
      CLIENT_URL.test(third.page.url()),
      "Open Claudebot showed the hidden window, already signed in on the client URL",
    );
    const list3 = await devices(third.page);
    check(
      list3.status === 200 &&
        list3.body.length === 1 &&
        list3.body[0]!.current &&
        list3.body[0]!.id !== list2.body[0]!.id,
      "the launch after a crash signs in and replaced the previous launch device (the data-root lock was free)",
    );
    const host3 = hostOf(third.pid) ?? fail("no host process is a child of the app");
    const hostGone = gone(host3.pid, "the host after app.quit()");
    await quit(third);
    info(`the host exited ${(((await hostGone) as number) / 1000).toFixed(1)}s after app.quit()`);
    const exits = hostLog()
      .split("\n")
      .filter((l) => l.includes("[desktop] host exited"));
    check(
      exits.at(-1)?.endsWith("host exited (0)") === true,
      `the app log records the host exiting with code 0 (${exits.at(-1)?.slice(25)})`,
    );
    await nothingRemains("the gracefully quit launch");
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    for (const p of leftovers(needles)) {
      console.log(`  cleaning up leftover ${describeProcess(p)}`);
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await landingServer.stop(true);
    await oauth.server.stop(true);
    const unchanged = defaultFolders.every(
      (d, i) => JSON.stringify(listing(d)) === JSON.stringify(beforeDefaults[i]![1]),
    );
    const traces = libraryTraces();
    console.log("\ndefault locations, before and after");
    for (const [d, before] of beforeDefaults) {
      info(
        `${d}: ${before.length ? `${before.length} entries (two levels)` : "does not exist"} before, ${listing(d).length ? `${listing(d).length}` : "does not exist"} after`,
      );
    }
    info(
      `~/Library entries named *claudebot* (three levels): before ${beforeTraces.length}, after ${traces.length}`,
    );
    for (const t of traces.filter((t) => !beforeTraces.includes(t))) info(`  new or changed: ${t}`);
    info(
      unchanged
        ? "default data and user-data folders: identical listings"
        : "default folder listings DIFFER (see above)",
    );
    await cleanup();
  }
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

const engineProcesses = (needles: string[]) =>
  leftovers(needles).filter(
    (p) => !p.command.includes(FAKE_CLAUDE) && /agent-browser|Chrome for Testing/.test(p.command),
  );

/** The agent listener's browser endpoint and the bot's bearer, from the last launch the fake CLI recorded; the bearer never leaves this process. */
function browserEndpoint(stateDir: string): { url: string; authorization: string } | undefined {
  const file = join(stateDir, "launches.jsonl");
  if (!existsSync(file)) return undefined;
  const launches = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const last = JSON.parse(launches.at(-1) ?? "{}") as {
    mcpServers?: Record<string, { url?: string; headers?: { Authorization?: string } }>;
  };
  const server = last.mcpServers?.browser;
  return server?.url && server.headers?.Authorization
    ? { url: server.url, authorization: server.headers.Authorization }
    : undefined;
}

/** One Streamable HTTP MCP session from this process, as the bot's Claude CLI would hold: initialize, then a single tool call. */
async function callBrowserTool(
  endpoint: { url: string; authorization: string },
  name: string,
  args: object,
): Promise<{ isError: boolean; text: string }> {
  let session: string | undefined;
  const post = async (body: object): Promise<unknown> => {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: endpoint.authorization,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    session ??= res.headers.get("mcp-session-id") ?? undefined;
    const text = await res.text();
    if (!res.ok) fail(`MCP ${(body as { method: string }).method} answered ${res.status}`);
    const data = res.headers.get("content-type")?.includes("event-stream")
      ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "data: null").slice(5)
      : text;
    return data.trim() ? JSON.parse(data) : undefined;
  };
  await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const reply = (await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { isError?: boolean; content?: { text?: string }[] } };
  return {
    isError: reply.result?.isError === true,
    text: (reply.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
  };
}

/** Starts a real engine session and Chrome for the bot whose turn is held open, as the bot would: `browser_open` over MCP with the bot's bearer, no model turn. Returns the engine and Chrome processes. */
async function startEngine(
  stateDir: string,
  needles: string[],
  fixturePort: number,
): Promise<ProcessRow[]> {
  const endpoint = await until("the bot's CLI launch to name the browser endpoint", 30_000, () =>
    browserEndpoint(stateDir),
  );
  const target = `http://127.0.0.1:${fixturePort}/engine`;
  const result = await callBrowserTool(endpoint, "browser_open", { url: target });
  info(
    `browser_open ${target} (fixture bot, driven by the smoke): isError=${result.isError} ${result.text.slice(0, 140).replace(/\s+/g, " ")}`,
  );
  const rows = await until("the engine and Chrome to run", 60_000, () => {
    const found = engineProcesses(needles);
    return found.some((p) => /agent-browser/.test(p.command)) &&
      found.some((p) => /Chrome for Testing/.test(p.command))
      ? found
      : undefined;
  });
  for (const p of rows.slice(0, 4)) info(`engine ${describeProcess(p)}`);
  check(true, `the engine and Chrome are running (${rows.length} processes)`);
  return rows;
}

try {
  await main();
  console.log("\nsmoke passed");
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
