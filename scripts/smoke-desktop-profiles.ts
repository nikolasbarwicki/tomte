import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import type { ElectronApplication, Page } from "playwright-core";

// Smoke test for the desktop app's remote connection profiles, run for real against the packaged app:
//   bun scripts/smoke-desktop-profiles.ts [dist/desktop/Tomte-darwin-arm64/mac-arm64/Tomte.app]
// Needs `bun run package:desktop` first (it also builds dist/host/tomte-host-<os>-<arch>, the fixture host).
// Everything runs on a fresh temp root under the isolation rules of the DESK briefs: file secrets backend, Chromium's
// mock keychain (so the safeStorage key is Chromium's mock key, NOT the real keychain), a fake Claude CLI, no default
// folders. These are FIXTURES, not a VPS: the "remote" host is a second compiled host on loopback http, the mismatch
// and TLS servers are Bun fixtures, and `shell.openExternal` is a recording stub.
// Covered: Add through the Connections window (token encrypted in profiles.json), Connect, the navigation/OAuth policy
// on the new origin, Forget (revoke), the API version check, an invalid TLS certificate, a refused plain-HTTP URL, and
// startup on a saved active profile with and without its host. Never prints a token, pairing code or cookie value.
import { API_VERSION } from "../packages/contract/src/api.ts";
import { oauthFixture } from "../packages/host/src/testing/fake-oauth-server.ts";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  ROOT,
  CLIENT_URL,
  check,
  clickTray,
  createSmokeRun,
  defaultFolders,
  describeProcess,
  fail,
  info,
  libraryTraces,
  listing,
  sleep,
  trayView,
  until,
  type Launched,
} from "./desktop-smoke-kit.ts";
import { processes } from "./process-guard.ts";

const CONNECTIONS_SCHEME = "tomte-desktop://connections";
const HOST_OS = process.platform === "win32" ? "windows" : process.platform;
const HOST_BINARY = join(ROOT, "dist/host", `tomte-host-${HOST_OS}-${process.arch}`);
const DEVICE_NAME = `${hostname()} (desktop)`;

interface StoredProfiles {
  active: string;
  profiles: { id: string; name: string; origin: string; deviceId: string; token: string }[];
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port ?? fail("no free port");
}

async function runBinary(binary: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawn([binary, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout: stdout.trim(), code };
}

async function main(): Promise<void> {
  if (!existsSync(HOST_BINARY))
    fail(`no host binary at ${HOST_BINARY}; run \`bun run package:desktop\``);
  const run = await createSmokeRun(process.argv[2], "tomte-desktop-profiles-smoke-");
  const {
    root,
    userData,
    fakeCli,
    launched,
    launch,
    devices,
    hostOf,
    nothingRemains,
    quit,
    sweep,
    cleanup,
  } = run;
  const oauth = oauthFixture();
  const beforeDefaults = defaultFolders.map((d) => [d, listing(d)] as const);
  const beforeTraces = libraryTraces();
  console.log(`temp root ${root}`);
  console.log(`app       ${run.appBundle}`);

  // ---- fixtures -------------------------------------------------------------------------------------------------
  const remoteBin = join(root, "bin/tomte-host-remote");
  await mkdir(join(root, "bin"));
  await copyFile(HOST_BINARY, remoteBin);
  await chmod(remoteBin, 0o755);
  const remoteData = join(root, "remote-data");
  const remoteFlags = ["--data-root", remoteData];
  const remoteEnv = run.launchEnv({ CLAUDE_PATH: fakeCli, TOMTE_DATA_ROOT: remoteData });
  const remotePort = await freePort();
  const remote = Bun.spawn([remoteBin, ...remoteFlags, "--port", String(remotePort)], {
    env: remoteEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  void (async () => {
    for await (const _ of remote.stdout) {
      // Keep draining so the fixture host never blocks on a full pipe.
    }
  })();
  const remoteOrigin = `http://127.0.0.1:${remotePort}`;
  await until("the fixture host to answer", 60_000, () =>
    fetch(`${remoteOrigin}/api/host-info`).then(
      (r) => r.ok,
      () => false,
    ),
  );
  const bearer = (token: string) => ({
    authorization: `Bearer ${token}`,
    origin: remoteOrigin,
    "content-type": "application/json",
  });
  const pairingCode = async () => {
    const paired = await runBinary(remoteBin, ["pair", ...remoteFlags], remoteEnv);
    if (paired.code !== 0 || paired.stdout === "")
      fail("the fixture host's `pair` printed no code");
    return paired.stdout;
  };

  /** A fixture host-info server whose API version, and request count, the smoke controls. */
  let fixtureApi = API_VERSION + 1;
  const fixtureRequests: string[] = [];
  const mismatch = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      fixtureRequests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({
        version: "fixture",
        apiVersion: fixtureApi,
        mode: "local",
        capabilities: { reveal: false, headedBrowser: false, browserSandbox: false },
      });
    },
  });
  const certDir = join(root, "tls");
  await mkdir(certDir);
  const openssl = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (openssl.exitCode !== 0) fail("openssl could not create the self-signed certificate");
  const tlsRequests: string[] = [];
  const tlsFixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(join(certDir, "key.pem")), cert: Bun.file(join(certDir, "cert.pem")) },
    fetch(req) {
      tlsRequests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({});
    },
  });

  // ---- helpers over the packaged app -----------------------------------------------------------------------------
  const profilesFile = join(userData, "profiles.json");
  const readProfiles = (): StoredProfiles | undefined =>
    existsSync(profilesFile)
      ? (JSON.parse(readFileSync(profilesFile, "utf8")) as StoredProfiles)
      : undefined;
  const connectionsPage = (app: ElectronApplication): Page | undefined =>
    app.windows().find((w) => w.url().startsWith(CONNECTIONS_SCHEME));

  /** Opens the Connections window through the application menu, as a user would. */
  async function openConnections(app: ElectronApplication): Promise<Page> {
    const existing = connectionsPage(app);
    if (existing) return existing;
    const opened = app.waitForEvent("window", { timeout: 15_000 });
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!.items.find((i) => i.label === "Connections")!;
      menu.submenu!.items.find((i) => i.label.startsWith("Manage Connections"))!.click();
    });
    const page = await opened;
    await page.waitForLoadState();
    return page;
  }

  /** Runs `action` on the Connections page and waits for the 303 to land on the next list page. */
  async function submit(page: Page, action: () => Promise<void>): Promise<string> {
    const before = page.url();
    await action();
    await page.waitForURL((u) => u.href !== before, { timeout: 30_000 });
    await page.waitForLoadState();
    return (await page.locator(".notice").first().innerText()).trim();
  }

  async function addProfile(page: Page, name: string, url: string, code: string): Promise<string> {
    await page.locator("#name").fill(name);
    await page.locator("#url").fill(url);
    await page.locator("#code").fill(code);
    return submit(page, () => page.locator("form.add button").click());
  }

  const rowButton = (page: Page, name: string, button: "Connect" | "Forget") =>
    page.locator("li", { hasText: name }).getByRole("button", { name: button, exact: true });

  const menuState = (app: ElectronApplication) =>
    app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((i) => i.label === "Connections")!
        .submenu!.items.filter((i) => i.type === "radio")
        .map((i) => `${i.label}${i.checked ? "*" : ""}`),
    );

  const installOpenExternalStub = (app: ElectronApplication) =>
    app.evaluate(({ shell }) => {
      const urls: string[] = [];
      Reflect.set(globalThis, "opened", urls);
      shell.openExternal = async (url: string) => void urls.push(url);
    });
  const opened = (app: ElectronApplication): Promise<string[]> =>
    app.evaluate(() => Reflect.get(globalThis, "opened") as string[]);
  const mainPage = (l: Launched) => l.page;

  /** The tray's connection radios as "name" or "name*" (checked), for This computer and the fixture profile. */
  const trayConnections = async (l: Launched) =>
    (await trayView(l)).items
      .filter((i) => i.label === "This computer" || i.label === "Fixture remote")
      .map((i) => `${i.label}${i.checked ? "*" : ""}`)
      .join("|");
  const untilTray = (l: Launched, expected: string) =>
    until(
      `the tray to show ${expected}`,
      10_000,
      async () => (await trayConnections(l)) === expected,
    );

  try {
    // ---- launch A -----------------------------------------------------------------------------------------------
    console.log(
      "\n[1] launch the packaged app (fake Claude CLI stub); open Connections from the menu",
    );
    const a = await launch({ CLAUDE_PATH: fakeCli }, FIRST_LAUNCH_TIMEOUT_MS);
    const main = mainPage(a);
    const localOrigin = new URL(a.clientUrl).origin;
    const own = await devices(main);
    check(
      own.body.length === 1 && own.body[0]!.name === "This computer",
      "the local sidecar is signed in",
    );
    check(
      (await menuState(a.app)).join("|") === "This computer*",
      "the Connections menu lists only This computer, selected",
    );
    const manager = await openConnections(a.app);
    const prefs = await a.app.evaluate(({ BrowserWindow, session }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().startsWith("tomte-desktop:"),
      )!;
      const p = w.webContents.getLastWebPreferences()!;
      return {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
        webviewTag: p.webviewTag,
        preload: p.preload ?? null,
        ownSession: w.webContents.session !== session.defaultSession,
      };
    });
    check(
      prefs.contextIsolation === true &&
        prefs.sandbox === true &&
        prefs.nodeIntegration === false &&
        prefs.webviewTag === false &&
        prefs.preload === null &&
        prefs.ownSession,
      `the Connections window has the host window's webPreferences, no preload, and its own session ${JSON.stringify(prefs)}`,
    );
    const reach = await main.evaluate(() =>
      fetch("tomte-desktop://connections/").then(
        () => "reachable",
        () => "unreachable",
      ),
    );
    check(reach === "unreachable", "the host UI's session cannot reach the tomte-desktop: scheme");
    const csp = await manager.evaluate(async () => {
      const s = document.createElement("script");
      s.textContent = "window.__injected = true";
      document.head.append(s);
      return { injected: "__injected" in window };
    });
    check(!csp.injected, "an inline script injected into the Connections page does not run (CSP)");
    check(
      (await a.app.evaluate(
        async ({ session }) => (await session.defaultSession.cookies.get({})).length,
      )) === 1,
      "the default session holds exactly the local sidecar's one session cookie",
    );

    console.log(
      "\n[2] Add the fixture remote host through the Connections form (fixture: a second compiled host)",
    );
    const observer = await (async () => {
      const response = await fetch(`${remoteOrigin}/api/pair`, {
        method: "POST",
        headers: { origin: remoteOrigin, "content-type": "application/json" },
        body: JSON.stringify({ code: await pairingCode(), name: "smoke observer" }),
      });
      return (await response.json()) as { deviceId: string; token: string };
    })();
    await a.app.evaluate(async ({ session }) => {
      const found = await session.defaultSession.cookies.get({ name: "tomte_session" });
      Reflect.set(globalThis, "cookieBefore", found.map((c) => c.value).join());
    });
    const code = await pairingCode();
    const notice = await addProfile(manager, "Fixture remote", remoteOrigin, code);
    info(`page says: ${notice}`);
    check(notice.startsWith('Added "Fixture remote"'), "the page confirms the add");
    check(
      !manager.url().includes(code.replace(/-/g, "")) && !manager.url().includes(code),
      "the redirect URL carries no pairing code",
    );
    check(/\?m=[0-9a-f-]{36}$/.test(manager.url()), "...only a random message id");
    const stored = readProfiles() ?? fail("profiles.json was not written");
    const profile = stored.profiles[0] ?? fail("no profile in profiles.json");
    check(
      stored.profiles.length === 1 && stored.active === "local" && profile.origin === remoteOrigin,
      "profiles.json has one profile (origin, device id) and local still active",
    );
    const raw = readFileSync(profilesFile, "utf8");
    const heldToken = await a.app.evaluate(
      async ({ safeStorage }, encrypted) =>
        (await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"))).result,
      profile.token,
    );
    check(
      heldToken.length >= 40 &&
        profile.token !== heldToken &&
        !raw.includes(heldToken) &&
        raw.includes(profile.deviceId),
      "profiles.json has the device id and safeStorage ciphertext; the raw file does not contain the token (compared with the token decrypted in main, held in memory)",
    );
    check((statSync(profilesFile).mode & 0o777) === 0o600, "profiles.json is mode 0600");
    info(
      "NOTE: --use-mock-keychain, so the encryption key is Chromium's mock key; the real-keychain path is not exercised",
    );
    const listed = await fetch(`${remoteOrigin}/api/devices/list`, {
      method: "POST",
      headers: bearer(observer.token),
      body: "{}",
    });
    const fixtureDevices = (await listed.json()) as { id: string; name: string }[];
    check(
      fixtureDevices.some((d) => d.id === profile.deviceId && d.name === DEVICE_NAME),
      `the fixture host lists the new device as "${DEVICE_NAME}"`,
    );
    const tokenWorks = await fetch(`${remoteOrigin}/api/devices/list`, {
      method: "POST",
      headers: bearer(heldToken),
      body: "{}",
    });
    check(
      tokenWorks.status === 200,
      "the decrypted token is a valid device token on the fixture host",
    );
    const cookieAfter = await a.app.evaluate(async ({ session }) => {
      const found = await session.defaultSession.cookies.get({ name: "tomte_session" });
      return found.map((c) => c.value).join() === Reflect.get(globalThis, "cookieBefore");
    });
    check(
      cookieAfter,
      "pairing set no cookie in the window's session (requests carry credentials: omit)",
    );
    const wrong = await addProfile(manager, "Second", remoteOrigin, "AAAA-BBBB-CCCC");
    check(/already added/.test(wrong), `a second add of the same origin is refused (${wrong})`);
    const wrongCode = await addProfile(
      manager,
      "Wrong code",
      `http://localhost:${remotePort}`,
      "AAAA-BBBB-CCCC",
    );
    check(
      wrongCode.includes("invalid pairing code") && readProfiles()!.profiles.length === 1,
      `a wrong code shows the host's error and stores nothing (${wrongCode})`,
    );
    check(
      (await manager.locator("#name").inputValue()) === "Wrong code" &&
        (await manager.locator("#code").inputValue()) === "",
      "the form is refilled with name and address, never the code",
    );

    console.log("\n[3] Connect; navigation and OAuth policy follow the new origin");
    await installOpenExternalStub(a.app);
    const connectNotice = await submit(manager, () =>
      rowButton(manager, "Fixture remote", "Connect").click(),
    );
    check(connectNotice === "Connected.", "the page confirms the connect");
    await main.waitForURL(`${remoteOrigin}/**`, { timeout: 30_000 });
    const onRemote = await devices(main);
    check(
      onRemote.status === 200 &&
        onRemote.body.some((d) => d.current && d.id === profile.deviceId && d.name === DEVICE_NAME),
      "the main window is on the fixture origin and /api/devices/list shows this app's device as current",
    );
    check(readProfiles()!.active === profile.id, "profiles.json saved the connection as active");
    await until(
      "the menu to show the active profile",
      5000,
      async () => (await menuState(a.app)).join("|") === "This computer|Fixture remote*",
    );
    check(true, "the Connections menu radio follows: This computer | Fixture remote*");
    const here = main.url();
    await main.evaluate((url) => void (location.href = url), `${localOrigin}/`);
    await until("the old local origin to reach openExternal", 5000, async () =>
      (await opened(a.app)).includes(`${localOrigin}/`),
    );
    await sleep(300);
    check(
      main.url() === here,
      "the old local origin is now foreign: blocked and handed to openExternal (stub); the window stays on the fixture",
    );
    const openedBefore = (await opened(a.app)).length;
    await main.goto(`${remoteOrigin}/integrations`);
    await main.getByRole("button", { name: "Add custom" }).click();
    await main.locator("#custom-name").fill("fixture");
    await main.locator("#custom-url").fill(oauth.url);
    await main.getByRole("switch", { name: "Sign in with OAuth" }).click();
    await main.getByRole("button", { name: "Add server" }).click();
    const authorize = await until("the authorize URL to reach openExternal", 30_000, async () =>
      (await opened(a.app))
        .slice(openedBefore)
        .find((u) => u.startsWith(`${new URL(oauth.url).origin}/authorize`)),
    );
    check(
      new URL(authorize).searchParams.get("response_type") === "code",
      "the OAuth connect on the fixture profile reaches openExternal (recording stub, loopback fixture provider)",
    );
    await main.evaluate(() => localStorage.setItem("smoke", "remote-origin-storage"));

    console.log(
      "\n[3b] tray: the connection items (their click handlers, as the real menu runs them)",
    );
    const trayLabels = (await trayView(a)).items.map((i) => i.label);
    check(
      trayLabels.includes("Manage Connections…") &&
        trayLabels.includes("Open Tomte") &&
        trayLabels.includes("Start at login") &&
        trayLabels.includes("Quit Tomte"),
      "the tray keeps Open Tomte, Start at login and Quit, and gains Manage Connections…",
    );
    await untilTray(a, "This computer|Fixture remote*");
    check(true, "the tray shows the active profile checked: This computer | Fixture remote*");
    await clickTray(a, "This computer");
    await main.waitForURL(`${localOrigin}/**`, { timeout: 30_000 });
    const trayLocal = await devices(main);
    await untilTray(a, "This computer*|Fixture remote");
    check(
      trayLocal.status === 200 &&
        trayLocal.body[0]?.name === "This computer" &&
        readProfiles()!.active === "local",
      "the tray's This computer item switched the window to the local host (signed in, saved as active); the tray follows",
    );
    await clickTray(a, "Fixture remote");
    await main.waitForURL(`${remoteOrigin}/**`, { timeout: 30_000 });
    const trayRemote = await devices(main);
    await untilTray(a, "This computer|Fixture remote*");
    check(
      trayRemote.status === 200 &&
        trayRemote.body.some((d) => d.current && d.id === profile.deviceId) &&
        readProfiles()!.active === profile.id &&
        (await menuState(a.app)).join("|") === "This computer|Fixture remote*",
      "the tray's Fixture remote item switched back (signed in as this app's device, saved as active); tray and app menu agree",
    );

    console.log(
      "\n[4] Forget: revoke on the host, delete the profile, clear the origin, back to local",
    );
    const forgetNotice = await submit(manager, () =>
      rowButton(manager, "Fixture remote", "Forget").click(),
    );
    check(forgetNotice === "Connection forgotten.", "the page confirms the forget");
    const afterForget = await fetch(`${remoteOrigin}/api/devices/list`, {
      method: "POST",
      headers: bearer(observer.token),
      body: "{}",
    });
    const remaining = (await afterForget.json()) as { id: string }[];
    check(
      !remaining.some((d) => d.id === profile.deviceId),
      "the fixture host's device list no longer has the device",
    );
    const stale = await fetch(`${remoteOrigin}/api/devices/list`, {
      method: "POST",
      headers: bearer(heldToken),
      body: "{}",
    });
    check(stale.status === 401, "the held token now gets 401 from /api/devices/list");
    const afterProfiles = readProfiles()!;
    check(
      afterProfiles.profiles.length === 0 && afterProfiles.active === "local",
      "profiles.json has no profile and local is active",
    );
    await main.waitForURL(`${localOrigin}/**`, { timeout: 30_000 });
    const backLocal = await devices(main);
    check(
      backLocal.status === 200 &&
        backLocal.body.length === 1 &&
        backLocal.body[0]!.name === "This computer",
      "the window is back on the local client URL and still signed in",
    );
    const leftover = await a.app.evaluate(async ({ BrowserWindow, session }, origin) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: { session: session.defaultSession },
      });
      await w.loadURL(`${origin}/`);
      const value = await w.webContents.executeJavaScript(`localStorage.getItem("smoke")`);
      w.destroy();
      return value as string | null;
    }, remoteOrigin);
    check(leftover === null, "the forgotten origin's local storage was cleared from the session");
    check(
      (await menuState(a.app)).join("|") === "This computer*",
      "the Connections menu is back to This computer*",
    );

    console.log("\n[5] API version mismatch (loopback fixture, nothing stored)");
    const mismatchOrigin = `http://127.0.0.1:${mismatch.port}`;
    fixtureApi = API_VERSION + 1;
    const newer = await addProfile(manager, "Newer host", mismatchOrigin, "AAAA-BBBB-CCCC");
    info(`page says: ${newer}`);
    check(
      newer ===
        `The host at ${mismatchOrigin} runs API version ${API_VERSION + 1}; this app needs ${API_VERSION}. Update the desktop app.`,
      'a newer host shows "... Update the desktop app."',
    );
    fixtureApi = API_VERSION - 1;
    const older = await addProfile(manager, "Older host", mismatchOrigin, "AAAA-BBBB-CCCC");
    info(`page says: ${older}`);
    check(
      older.endsWith("Update the host.") && older.includes(`API version ${API_VERSION - 1}`),
      'an older host shows "... Update the host."',
    );
    check(
      readProfiles()!.profiles.length === 0 &&
        fixtureRequests.every((r) => r === "GET /api/host-info") &&
        fixtureRequests.length === 2,
      `nothing stored, and the fixture saw only the two host-info reads (${fixtureRequests.join(", ")})`,
    );

    console.log(
      "\n[6] invalid TLS certificate (self-signed, generated in the temp dir; no trust change)",
    );
    const tlsOrigin = `https://127.0.0.1:${tlsFixture.port}`;
    const tls = await addProfile(manager, "Self signed", tlsOrigin, "AAAA-BBBB-CCCC");
    info(`page says: ${tls}`);
    check(
      /certificate/.test(tls) && /ERR_CERT/.test(tls),
      "add fails with a certificate error naming net::ERR_CERT_*",
    );
    check(
      readProfiles()!.profiles.length === 0 && tlsRequests.length === 0,
      "nothing stored, and no request got through to the fixture; no certificate-error handler or trust setting exists",
    );

    console.log("\n[7] a non-loopback http: URL is refused before any request");
    const reached = await fetch(`http://localhost.:${mismatch.port}/probe`).then(
      (r) => r.status,
      () => 0,
    );
    info(
      `sanity: http://localhost.:<port> ${reached === 200 ? "does reach the loopback fixture" : "is not reachable here"}`,
    );
    const requestsBefore = fixtureRequests.length;
    const plain = await addProfile(
      manager,
      "Plain http",
      `http://localhost.:${mismatch.port}`,
      "AAAA-BBBB-CCCC",
    );
    info(`page says: ${plain}`);
    check(plain.startsWith("Plain http://"), "the page refuses it with the plain-http explanation");
    check(fixtureRequests.length === requestsBefore, "the fixture received no request for it");

    console.log("\n[8] startup on a saved active profile");
    const code2 = await pairingCode();
    await addProfile(manager, "Fixture remote", remoteOrigin, code2);
    await submit(manager, () => rowButton(manager, "Fixture remote", "Connect").click());
    await main.waitForURL(`${remoteOrigin}/**`, { timeout: 30_000 });
    const profile2 = readProfiles()!.profiles[0]!;
    check(
      readProfiles()!.active === profile2.id,
      "the second add is connected and saved as active",
    );
    await quit(a);
    await nothingRemains("launch A", [remote.pid]);

    const b = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS);
    const startup = await devices(b.page);
    check(
      startup.status === 200 && startup.body.some((d) => d.current && d.id === profile2.deviceId),
      "a relaunch connects to the saved active profile (the window shows the fixture host as this app's device)",
    );
    check(!connectionsPage(b.app), "no Connections window opened, nothing went wrong");

    console.log(
      "\n[8b] the local host stops and restarts (tray), with local and with a remote shown",
    );
    await untilTray(b, "This computer|Fixture remote*");
    await clickTray(b, "This computer");
    await untilTray(b, "This computer*|Fixture remote");
    const localBefore = await until("the local host's UI to be signed in", 30_000, async () => {
      const d = await devices(b.page).catch(() => undefined);
      return d?.status === 200 && d.body[0]!.current ? d : undefined;
    });
    const hostB = hostOf(b.pid) ?? fail("no host process is a child of the app");
    info(`kill -9 the local host alone (pid ${hostB.pid}) while This computer is shown`);
    process.kill(hostB.pid, "SIGKILL");
    await until("the window to show that the host is not running", 15_000, async () =>
      (await b.page.textContent("body").catch(() => ""))?.includes("host is not running"),
    );
    const stoppedB = await trayView(b);
    check(
      stoppedB.status === "stopped" && stoppedB.items.some((i) => i.label === "Restart host"),
      'with local shown, the window shows "host is not running" and the tray offers Restart host',
    );
    await clickTray(b, "Fixture remote");
    await b.page.waitForURL(`${remoteOrigin}/**`, { timeout: 30_000 });
    const remoteWhileStopped = await devices(b.page);
    check(
      remoteWhileStopped.status === 200 &&
        remoteWhileStopped.body.some((d) => d.current && d.id === profile2.deviceId) &&
        (await trayView(b)).status === "stopped",
      "a remote profile connects and works while the local host is stopped",
    );
    await clickTray(b, "This computer");
    await until("the window to show that the host is not running", 15_000, async () =>
      (await b.page.textContent("body").catch(() => ""))?.includes("host is not running"),
    );
    await clickTray(b, "Restart host");
    await until(
      "the host to run again",
      120_000,
      async () => (await trayView(b)).status === "running",
    );
    await b.page.waitForURL(CLIENT_URL, { timeout: 60_000 });
    const hostB2 = hostOf(b.pid) ?? fail("no host process is a child of the app after the restart");
    const localAfter = await devices(b.page);
    check(
      hostB2.pid !== hostB.pid &&
        localAfter.status === 200 &&
        localAfter.body.length === 1 &&
        localAfter.body[0]!.current &&
        localAfter.body[0]!.id !== localBefore.body[0]!.id &&
        (await trayConnections(b)) === "This computer*|Fixture remote",
      `"Restart host" with local shown: the window is signed in on the new host (pid ${hostB2.pid}, new device id) and the tray shows This computer checked`,
    );
    await clickTray(b, "Fixture remote");
    await b.page.waitForURL(`${remoteOrigin}/**`, { timeout: 30_000 });
    await untilTray(b, "This computer|Fixture remote*");
    check(
      readProfiles()!.active === profile2.id,
      "the remote profile is saved as active again for the next start",
    );
    await quit(b);
    await nothingRemains("launch B", [remote.pid]);

    remote.kill("SIGTERM");
    await remote.exited;
    const c = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS);
    const fallback = await devices(c.page);
    check(
      fallback.status === 200 && fallback.body[0]?.name === "This computer",
      "with the saved host down, the app falls back to This computer",
    );
    const message = await until("the Connections window with the reason", 15_000, () =>
      connectionsPage(c.app),
    );
    await message.waitForLoadState();
    const reason = (await message.locator(".notice").first().innerText()).trim();
    info(`page says: ${reason}`);
    check(
      reason.startsWith('Could not connect to "Fixture remote"') &&
        reason.endsWith("Showing This computer instead."),
      "the Connections window opens with the reason",
    );
    check(readProfiles()!.active === profile2.id, "the saved choice is kept for the next start");
    const unreachable = await submit(message, () =>
      rowButton(message, "Fixture remote", "Forget").click(),
    );
    check(
      /Could not reach/.test(unreachable) &&
        /stays valid on the host/.test(unreachable) &&
        readProfiles()!.profiles.length === 1,
      "Forget with the host down keeps the profile and says the device stays valid until revoked on the host",
    );
    const forced = await submit(message, () =>
      message.getByRole("button", { name: "Forget without revoking" }).click(),
    );
    check(
      forced === "Connection forgotten." && readProfiles()!.profiles.length === 0,
      "Forget without revoking removes it",
    );
    await quit(c);
    await nothingRemains("launch C");
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    remote.kill("SIGKILL");
    await remote.exited;
    for (const p of sweep()) console.log(`  cleaned up leftover ${describeProcess(p)}`);
    await mismatch.stop(true);
    await tlsFixture.stop(true);
    await oauth.server.stop(true);
    const unchanged = defaultFolders.every(
      (d, i) => JSON.stringify(listing(d)) === JSON.stringify(beforeDefaults[i]![1]),
    );
    const traces = libraryTraces();
    console.log("\ndefault locations, before and after");
    info(
      `~/Library entries named *tomte* (three levels): before ${beforeTraces.length}, after ${traces.length}`,
    );
    for (const t of traces.filter((t) => !beforeTraces.includes(t))) info(`  new or changed: ${t}`);
    info(
      unchanged
        ? "default data and user-data folders: identical listings"
        : "default folder listings DIFFER",
    );
    const stillRunning = processes().filter((p) => p.pid === remote.pid);
    info(
      stillRunning.length === 0 ? "the fixture host is gone" : "the fixture host is STILL RUNNING",
    );
    await cleanup();
  }
}

try {
  await main();
  console.log("\nsmoke passed");
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
