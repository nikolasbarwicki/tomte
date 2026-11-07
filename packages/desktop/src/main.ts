// The desktop app's main process: starts the bundled host as a sidecar, signs the window in and shows the UI the host serves.
// It runs no host code; the host is a separate binary that it spawns and whose pipe it holds. Closing the window leaves the app and the host running in the tray.
import { join } from "node:path";

import { app } from "electron";

import { installAppMenu } from "./app-menu.ts";
import { keepInTray, type Background } from "./background.ts";
import { registerConnectionsScheme } from "./connections-window.ts";
import { setupConnections } from "./desktop-connections.ts";
import { createLoginItem } from "./electron-login-item.ts";
import { hostBinaryPath } from "./host-binary.ts";
import { installNavigationPolicy } from "./navigation.ts";
import { startSidecar } from "./sidecar.ts";
import { createStartAtLogin, type StartAtLogin } from "./start-at-login.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";
import { createTray, type DesktopTray } from "./tray.ts";
import { createWindow } from "./window.ts";

// Bundled to packages/desktop/dist/main.cjs (CommonJS, so `__dirname` is the runtime folder), the repository root is three levels up when run from source.
const REPO_ROOT = join(__dirname, "../../..");

/** Quitting stops the host first: `before-quit` is held back until it has exited, then the app exits for real. Every way of quitting (tray, app menu, Cmd+Q, the OS) ends in `before-quit`. */
let quit: "running" | "stopping" | "stopped" = "running";

/** What a smoke test of the packaged app reads through this module's exports. Nothing in the app uses it. */
export const desktop: {
  supervisor?: Supervisor;
  tray?: DesktopTray;
  background?: Background;
  startAtLogin?: StartAtLogin;
} = {};

function start(): void {
  const log = (message: string) => console.error(`[desktop] ${message}`);
  const navigation = installNavigationPolicy();
  const loginItem = createLoginItem();
  const startAtLogin = createStartAtLogin(
    join(app.getPath("userData"), "settings.json"),
    loginItem,
    log,
  );
  // An app the OS opened at login stays in the tray; the window waits for "Open Claudebot".
  const window = createWindow(!loginItem.openedAtLogin());
  const background = keepInTray(window, () => quit !== "running");
  const logFile = join(app.getPath("userData"), "logs", "host.log");
  const supervisor = createSupervisor(() =>
    startSidecar(hostBinaryPath(app.isPackaged, process.resourcesPath, REPO_ROOT), logFile),
  );

  const connections = setupConnections({
    window,
    local: () => supervisor.state(),
    logFile,
    navigation,
    userData: app.getPath("userData"),
  });
  installAppMenu(connections);

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
    restartHost: () => void supervisor.start(),
    quit: () => app.quit(),
    connect: (id) => void connections.connect(id).then(render),
    manageConnections: () => connections.openConnections(),
  });

  /** The tray shows the host's state and the profiles; the newest render wins, since listing the profiles is asynchronous. */
  let rendered = 0;
  function render(): void {
    const mine = ++rendered;
    void connections.list().then((profiles) => {
      if (mine === rendered) tray.update(supervisor.state(), startAtLogin.enabled(), profiles);
    });
  }

  supervisor.onChange(() => {
    render();
    // The window follows the local host (starting, running with a new client URL and token, stopped) only while `local` is the connection it shows.
    if (quit === "running")
      void connections.localChanged().catch((error) => log(`local host: ${String(error)}`));
  });
  connections.onChange(render);
  render();

  Object.assign(desktop, { supervisor, tray, background, startAtLogin });
  app.on("second-instance", () => background.reveal());
  app.on("activate", () => background.reveal());
  // The host starts first so the window shows "Starting" rather than "not running" while the saved connection is chosen.
  void supervisor.start();
  void connections.start().catch((error) => log(`connections: ${String(error)}`));
}

app.enableSandbox();
registerConnectionsScheme();
// Electron's default user-data folder is named after the app, which on a case-insensitive disk is the host's default data root (`claudebot`): the two would share one folder. An explicit `--user-data-dir` wins.
if (!app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "Claudebot Desktop"));

app.on("before-quit", (event) => {
  if (quit === "stopped") return;
  event.preventDefault();
  if (quit === "stopping") return;
  quit = "stopping";
  void (desktop.supervisor?.stop() ?? Promise.resolve()).finally(() => {
    quit = "stopped";
    app.exit(0);
  });
});
// With the window hidden, no window is left open and that is not a reason to quit: the tray keeps the app.
app.on("window-all-closed", () => {});

if (app.requestSingleInstanceLock()) void app.whenReady().then(start);
else app.quit();
