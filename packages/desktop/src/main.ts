// The desktop app's main process: starts the bundled host as a sidecar, signs the window in and shows the UI the host serves.
// It runs no host code; the host is a separate binary that it spawns and whose pipe it holds. Closing the window leaves the app and the host running in the tray.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { app, net, shell } from "electron";

import { installAppMenu } from "./app-menu.ts";
import { keepInTray, type Background } from "./background.ts";
import { registerConnectionsScheme } from "./connections-window.ts";
import { setupConnections } from "./desktop-connections.ts";
import { setupFollow, type Notifier } from "./desktop-follow.ts";
import { createDesktopLog } from "./desktop-log.ts";
import { fileManagerName, handleDownload } from "./downloads.ts";
import { createLoginItem } from "./electron-login-item.ts";
import { createElectronUpdateEngine } from "./electron-update-engine.ts";
import { createHostClient } from "./host-api.ts";
import { hostBinaryPath } from "./host-binary.ts";
import { hostLines } from "./host-lines.ts";
import { createLocalHostQuestion, type LocalHostQuestion } from "./local-host-question.ts";
import { createLocalHostPolicy, localWanted } from "./local-policy.ts";
import { installNavigationPolicy } from "./navigation.ts";
import { openSettings } from "./settings.ts";
import { startSidecar } from "./sidecar.ts";
import { createStartAtLogin, type StartAtLogin } from "./start-at-login.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";
import { createTray, type DesktopTray } from "./tray.ts";
import {
  createUpdater,
  hostVersionMismatch,
  updatesDisabledReason,
  type Updater,
} from "./updates.ts";
import { createWindow } from "./window.ts";

// Bundled to packages/desktop/dist/main.cjs (CommonJS, so `__dirname` is the runtime folder), the repository root is three levels up when run from source.
const REPO_ROOT = join(__dirname, "../../..");

/** Quitting stops the host first: `before-quit` is held back until it has exited, then the app exits for real. Every way of quitting (tray, app menu, Cmd+Q, the OS) ends in `before-quit`. */
let quit: "running" | "stopping" | "stopped" = "running";
/** "Restart to update" quits like any other quit, so the host stops first; the installer runs once it has, and the host binary it replaces is not running. */
let restartForUpdate = false;
let log: (message: string) => void = (message) => console.error(`[desktop] ${message}`);

/** What a smoke test of the packaged app reads through this module's exports; the one thing it changes is `banner.notifier.show`, to record notes instead of raising OS banners. */
export const desktop: {
  supervisor?: Supervisor;
  tray?: DesktopTray;
  background?: Background;
  startAtLogin?: StartAtLogin;
  localHostQuestion?: LocalHostQuestion;
  banner?: { notifier: Notifier };
  updater?: Updater;
} = {};

function start(): void {
  log = createDesktopLog(join(app.getPath("userData"), "logs", "desktop.log"));
  const navigation = installNavigationPolicy();
  const loginItem = createLoginItem();
  const settings = openSettings(join(app.getPath("userData"), "settings.json"), log);
  const startAtLogin = createStartAtLogin(settings, loginItem);
  // An app the OS opened at login stays in the tray; the window waits for "Open Tomte".
  const window = createWindow(!loginItem.openedAtLogin());
  const background = keepInTray(window, () => quit !== "running");
  const logFile = join(app.getPath("userData"), "logs", "host.log");
  const supervisor = createSupervisor(() =>
    startSidecar(hostBinaryPath(app.isPackaged, process.resourcesPath, REPO_ROOT), logFile),
  );

  const question = createLocalHostQuestion(window, process.env);
  const localHost = createLocalHostPolicy({
    settings,
    supervisor,
    ask: (serverName) => question.ask(serverName),
    canAsk: () => background.visible(),
  });

  const connections = setupConnections({
    window,
    local: () => supervisor.state(),
    logFile,
    navigation,
    userData: app.getPath("userData"),
  });
  installAppMenu(connections);
  const follow = setupFollow({ window, background, connections, log });
  const banner = { notifier: follow.notifier };
  // Downloads the page starts (a file, or a folder as a zip) are saved to the downloads folder and announced; the announcement reveals the file.
  window.webContents.session.on("will-download", (_event, item) =>
    handleDownload(item, {
      folder: () => app.getPath("downloads"),
      exists: existsSync,
      notify: (note) => banner.notifier.show(note),
      reveal: (path) => shell.showItemInFolder(path),
      fileManager: fileManagerName(process.platform),
      log,
    }),
  );

  const tray = createTray(join(__dirname, "assets"), {
    open: () => background.reveal(),
    setStartAtLogin(enabled) {
      try {
        startAtLogin.set(enabled);
      } catch (error) {
        log(`could not change Start at login: ${String(error)}`);
      }
      render();
    },
    setLocalHost(setting) {
      try {
        settings.update({ localHost: setting });
      } catch (error) {
        log(`could not change Run this Mac's host: ${String(error)}`);
      }
      refreshLocalHost();
      render();
    },
    restartHost: () => void supervisor.want(true).catch(logLocalHost),
    quit: () => app.quit(),
    connect: (id) => void connections.connect(id).then(render),
    manageConnections: () => connections.openConnections(),
    restartToUpdate() {
      restartForUpdate = true;
      app.quit();
    },
  });

  const updater = startUpdater();

  const logLocalHost = (error: unknown) => log(`local host: ${String(error)}`);
  /** Lets the policy see the connection the window shows now: it asks the one-time question when a server has just been shown and pauses or starts this computer's host. The newest list wins, since listing the profiles is asynchronous. */
  let localHostSyncs = 0;
  function syncLocalHost(): void {
    const mine = ++localHostSyncs;
    void connections
      .list()
      .then(async (profiles) => {
        const shown = profiles.find((profile) => profile.active);
        if (mine === localHostSyncs && shown !== undefined) await localHost.reconcile(shown);
      })
      .catch(logLocalHost);
  }
  const refreshLocalHost = () => void localHost.refresh().catch(logLocalHost);
  connections.onChange(syncLocalHost);
  // A window that was hidden gets the question when it appears.
  window.on("show", refreshLocalHost);

  /** The tray shows a line per host, the profiles and a downloaded update; the newest render wins, since listing the profiles is asynchronous. */
  let rendered = 0;
  function render(): void {
    const mine = ++rendered;
    void connections.list().then((profiles) => {
      if (mine !== rendered) return;
      const update = updater?.state();
      tray.update(
        hostLines(profiles, supervisor.state(), follow.view),
        settings.get(),
        profiles,
        update?.status === "ready" ? update.version : undefined,
      );
    });
  }
  updater?.onChange(render);

  supervisor.onChange((state) => {
    render();
    if (state.status === "running" && app.isPackaged)
      void verifyHostVersion(state.sidecar.clientUrl);
    // The window follows the local host (starting, running with a new client URL and token, stopped) only while `local` is the connection it shows.
    if (quit === "running")
      void connections.localChanged().catch((error) => log(`local host: ${String(error)}`));
  });
  connections.onChange(render);
  follow.onChange(render);
  render();

  Object.assign(desktop, {
    supervisor,
    tray,
    background,
    startAtLogin,
    localHostQuestion: question,
    banner,
    updater,
  });
  app.on("second-instance", () => background.reveal());
  app.on("activate", () => background.reveal());
  // The host is wished first, by what the saved connection will show, so the window shows "Starting" rather than "not running" while that connection is chosen; with no answer to the one-time question yet it always runs.
  void connections
    .savedActive()
    .then((saved) => {
      void supervisor.want(localWanted(settings.get().localHost, saved)).catch(logLocalHost);
      return connections.start();
    })
    .catch((error) => log(`connections: ${String(error)}`));
}

const hostClient = createHostClient((url, init) => net.fetch(url, init));

/** The host and the app are released together; a sidecar that reports another version than the app is logged, since it means one of them was not replaced by the update. */
async function verifyHostVersion(clientUrl: string): Promise<void> {
  try {
    const info = await hostClient.checkHost(new URL(clientUrl).origin);
    const mismatch = hostVersionMismatch(info.version, app.getVersion());
    log(mismatch === undefined ? `host ${info.version} matches the app` : `WARNING: ${mismatch}`);
  } catch (error) {
    log(`could not read the host's version: ${String(error)}`);
  }
}

function readAppUpdateYml(): string | undefined {
  try {
    return readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8");
  } catch {
    return undefined;
  }
}

/** Starts the update checks, unless this process must not make any (see `updatesDisabledReason`). An updater that fails to start is logged and the app runs without it. */
function startUpdater(): Updater | undefined {
  try {
    const reason = updatesDisabledReason({
      env: process.env,
      isPackaged: app.isPackaged,
      feed: app.isPackaged ? readAppUpdateYml() : undefined,
    });
    if (reason !== undefined) {
      log(`updates are off: ${reason}`);
      return undefined;
    }
    const updater = createUpdater({ engine: createElectronUpdateEngine(log), log });
    updater.start();
    log(`updates are on (app ${app.getVersion()}): the first check follows the host's start`);
    return updater;
  } catch (error) {
    log(`updates could not start: ${String(error)}`);
    return undefined;
  }
}

/** The host has stopped. After "Restart to update" the downloaded installer runs now (it quits the app itself); when it cannot start, or nobody asked for an update, the app exits. */
function installUpdateOrExit(): void {
  if (restartForUpdate) {
    try {
      desktop.updater?.quitAndInstall();
      return;
    } catch (error) {
      log(`could not install the update: ${String(error)}; restarting the app instead`);
      app.relaunch();
    }
  }
  app.exit(0);
}

app.enableSandbox();
registerConnectionsScheme();
// Electron's default user-data folder is named after the app, which on a case-insensitive disk is the host's default data root (`tomte`): the two would share one folder. An explicit `--user-data-dir` wins.
if (!app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "Tomte Desktop"));

app.on("before-quit", (event) => {
  if (quit === "stopped") return;
  event.preventDefault();
  if (quit === "stopping") return;
  quit = "stopping";
  void (desktop.supervisor?.stop() ?? Promise.resolve()).finally(() => {
    quit = "stopped";
    installUpdateOrExit();
  });
});
// With the window hidden, no window is left open and that is not a reason to quit: the tray keeps the app.
app.on("window-all-closed", () => {});

if (app.requestSingleInstanceLock()) void app.whenReady().then(start);
else app.quit();
