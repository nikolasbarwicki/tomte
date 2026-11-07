// Shared by the packaged-desktop smokes (smoke-desktop.ts, smoke-desktop-profiles.ts): check/log helpers, process
// bookkeeping, the temp root that holds a run's data root, user-data folder, secrets key and fake Claude CLI, and the
// launcher that starts the packaged app on it under the isolation rules in the DESK brief (file secrets backend, mock
// keychain, fake CLAUDE_PATH, no default folders).
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron, type ElectronApplication, type Page } from "playwright-core";

export const ROOT = join(import.meta.dir, "..");
export const FAKE_CLAUDE = join(ROOT, "packages/host/src/testing/fake-claude.ts");
export const EVIDENCE_DIR = join(ROOT, ".scratch");
const DEFAULT_APP = join(
  ROOT,
  `dist/desktop/Claudebot-${process.platform}-${process.arch}/Claudebot.app`,
);

export const CLIENT_URL = /^http:\/\/127\.0\.0\.1:\d+\//;
export const FIRST_LAUNCH_TIMEOUT_MS = 240_000;
export const LAUNCH_TIMEOUT_MS = 60_000;

export const fail = (message: string): never => {
  throw new Error(`smoke failed: ${message}`);
};
export const check = (ok: boolean, message: string) => {
  if (!ok) fail(message);
  console.log(`  ok: ${message}`);
};
export const info = (message: string) => console.log(`  ${message}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) return fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  tty: string;
  command: string;
}

export function processes(): ProcessRow[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,tty=,command="]).stdout.toString();
  return out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3]!, command: m[4]! }] : [];
  });
}

export const alive = (pid: number) => processes().some((p) => p.pid === pid);

/** Every process whose command line names the temp root, the packaged app (so its helpers and its host), or the fake CLI. */
export function leftovers(needles: string[]): ProcessRow[] {
  return processes().filter(
    (p) =>
      p.pid !== process.pid &&
      !p.command.startsWith("ps ") &&
      needles.some((n) => p.command.includes(n)),
  );
}

export function describeProcess(p: ProcessRow): string {
  return `pid ${p.pid} ppid ${p.ppid} tty ${p.tty}  ${p.command.replace(/\s+--(?:inspect|remote-debugging-port)\S*/g, "").slice(0, 110)}`;
}

/** The files under `dir` as `path size mtimeMs` rows, two levels deep, or `[]` when it does not exist. */
export function listing(dir: string, depth = 2): string[] {
  if (!existsSync(dir)) return [];
  const rows: string[] = [];
  const walk = (d: string, level: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const s = statSync(p, { throwIfNoEntry: false });
      if (!s) continue;
      rows.push(`${p} ${s.size} ${Math.round(s.mtimeMs)}`);
      if (e.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return rows.sort();
}

/** Everything under ~/Library, three levels deep, whose name mentions claudebot: where a default user-data folder, cache, preferences file or saved state would be. */
export function libraryTraces(): string[] {
  const library = join(homedir(), "Library");
  const out = Bun.spawnSync(
    ["find", library, "-maxdepth", "3", "-iname", "*claudebot*", "-not", "-path", "*/Containers/*"],
    { stderr: "ignore" },
  ).stdout.toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => `${p} ${Math.round(statSync(p).mtimeMs)}`)
    .sort();
}

export const defaultFolders = [
  join(homedir(), "Library/Application Support/claudebot"),
  join(homedir(), "Library/Application Support/Claudebot Desktop"),
];

export interface Launched {
  app: ElectronApplication;
  page: Page;
  pid: number;
  clientUrl: string;
}

/** The tray as the app's main process holds it: the real `Tray` object's tooltip and menu items, and the window. */
interface DesktopHook {
  supervisor: { state(): { status: string } };
  tray: {
    snapshot(): {
      tooltip: string;
      items: { label?: string; type?: string; enabled?: boolean; checked?: boolean }[];
    };
  };
  background: { visible(): boolean };
}
type MainModule = { mainModule: { exports: { desktop: DesktopHook } } };

export const trayView = (l: Launched) =>
  l.app.evaluate(({ app, BrowserWindow }) => {
    const d = (process as unknown as MainModule).mainModule.exports.desktop;
    const snap = d.tray.snapshot();
    return {
      status: d.supervisor.state().status,
      tooltip: snap.tooltip,
      items: snap.items.map((i) => ({
        label: i.label ?? "",
        enabled: i.enabled ?? true,
        checked: i.checked ?? false,
      })),
      visible: d.background.visible(),
      dock: app.dock?.isVisible() ?? false,
      windows: BrowserWindow.getAllWindows().length,
    };
  });

/** Calls the `click` handler of the tray menu item with this label: the function the real menu item runs. */
export const clickTray = (l: Launched, label: string) =>
  l.app.evaluate((_electron, label) => {
    const d = (process as unknown as MainModule).mainModule.exports.desktop;
    const item = d.tray.snapshot().items.find((i) => i.label === label) as
      | { click?: () => void }
      | undefined;
    if (!item?.click) throw new Error(`no tray item "${label}" with a click handler`);
    item.click();
  }, label);

/** A fresh temp root with its isolation files, and the functions that launch and inspect the packaged app on it. */
export interface SmokeRun {
  appBundle: string;
  root: string;
  /** Substrings that identify every process of this run in `ps`. */
  needles: string[];
  dataRoot: string;
  userData: string;
  keyFile: string;
  /** The launches' `$HOME`: the engine's Chrome download, sockets and session state go here, never into the real home. */
  homeDir: string;
  /** Where the app records Start at login instead of asking the OS (`CLAUDEBOT_DESKTOP_LOGIN_ITEM_FILE`). */
  loginItemFile: string;
  /** The desktop settings file the app writes in its user-data folder. */
  settingsFile: string;
  fakeStateDir: string;
  fakeCli: string;
  /** Every app started by `launch`, so the `finally` block can close them. */
  launched: ElectronApplication[];
  launchEnv: (extra: Record<string, string>) => Record<string, string>;
  launch: (
    env: Record<string, string>,
    timeoutMs: number,
    extraArgs?: string[],
  ) => Promise<Launched>;
  devices: (page: Page) => Promise<{
    status: number;
    body: { id: string; name: string; current: boolean }[];
  }>;
  hostOf: (mainPid: number) => ProcessRow | undefined;
  gone: (pid: number, what: string, timeoutMs?: number) => Promise<number>;
  /** Waits until no process of the run remains, except those in `ignorePids` (a fixture the script itself keeps running). */
  nothingRemains: (label: string, ignorePids?: number[]) => Promise<void>;
  hostLog: () => string;
  quit: (l: Launched) => Promise<void>;
  /** Deletes the temp root and the temp home. */
  cleanup: () => Promise<void>;
}

/** Creates the temp root (data root, user-data directory, 0600 file-secrets key, fake Claude CLI wrapper) and the launcher for the packaged app at `appArg` (default: this machine's package output). */
export async function createSmokeRun(
  appArg: string | undefined,
  rootPrefix: string,
): Promise<SmokeRun> {
  if (process.platform !== "darwin") fail("only the macOS package is smoke-tested here");
  const appBundle = resolve(appArg ?? DEFAULT_APP);
  const executable = join(appBundle, "Contents/MacOS/Claudebot");
  if (!existsSync(executable))
    fail(`no packaged app at ${appBundle}; run \`bun run package:desktop\``);

  const root = await mkdtemp(join(tmpdir(), rootPrefix));
  // The engine's socket paths must stay under 104 bytes, so the home is short and apart from the root.
  const homeDir = await mkdtemp("/tmp/claudebot-desktop-home-");
  const needles = [root, realpathSync(root), homeDir, realpathSync(homeDir), appBundle];
  const dataRoot = join(root, "data");
  const userData = join(root, "user-data");
  const keyFile = join(root, "secrets.key");
  const loginItemFile = join(root, "login-item.json");
  const settingsFile = join(userData, "settings.json");
  const fakeStateDir = join(root, "fake-claude");
  await mkdir(fakeStateDir, { recursive: true });
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const fakeCli = join(root, "claude-wrapper");
  await writeFile(
    fakeCli,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} ${JSON.stringify(fakeStateDir)} "$@"\n`,
  );
  await chmod(fakeCli, 0o755);
  const launched: ElectronApplication[] = [];

  /** The environment of a launch: this process's, minus any claudebot or Claude setting of the developer's. */
  function launchEnv(extra: Record<string, string>): Record<string, string> {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] =>
          e[1] !== undefined &&
          !e[0].startsWith("CLAUDEBOT_") &&
          !e[0].startsWith("ELECTRON_") &&
          e[0] !== "CLAUDE_PATH" &&
          e[0] !== "CLAUDE_CONFIG_DIR",
      ),
    );
    return {
      ...base,
      HOME: homeDir,
      CLAUDEBOT_DATA_ROOT: dataRoot,
      CLAUDEBOT_SECRETS: "file",
      CLAUDEBOT_SECRETS_KEY_FILE: keyFile,
      CLAUDEBOT_DESKTOP_LOGIN_ITEM_FILE: loginItemFile,
      ...extra,
    };
  }

  async function launch(
    env: Record<string, string>,
    timeoutMs: number,
    extraArgs: string[] = [],
  ): Promise<Launched> {
    const app = await _electron.launch({
      executablePath: executable,
      args: ["--use-mock-keychain", `--user-data-dir=${userData}`, ...extraArgs],
      env: launchEnv(env),
      timeout: LAUNCH_TIMEOUT_MS,
    });
    launched.push(app);
    const page = await app.firstWindow();
    await page.waitForURL(CLIENT_URL, { timeout: timeoutMs });
    return {
      app,
      page,
      pid: app.process().pid ?? fail("no pid"),
      clientUrl: new URL(page.url()).origin + "/",
    };
  }

  const devices: SmokeRun["devices"] = (page) =>
    page.evaluate(async () => {
      const r = await fetch("/api/devices/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return {
        status: r.status,
        body: (await r.json()) as { id: string; name: string; current: boolean }[],
      };
    });

  const hostOf = (mainPid: number) =>
    processes().find(
      (p) => p.ppid === mainPid && p.command.includes("Contents/Resources/claudebot-host"),
    );

  /** Waits for the process to be gone and returns how long it took. */
  async function gone(pid: number, what: string, timeoutMs = 30_000): Promise<number> {
    const started = Date.now();
    await until(`${what} to exit`, timeoutMs, () => !alive(pid));
    return Date.now() - started;
  }

  async function nothingRemains(label: string, ignorePids: number[] = []): Promise<void> {
    await until(
      `no process from ${label} to remain`,
      30_000,
      () => leftovers(needles).filter((p) => !ignorePids.includes(p.pid)).length === 0,
    );
    check(
      true,
      `ps shows no process from ${label} (temp root, packaged app, host, Claude CLI, engine, Chrome, Electron helpers)`,
    );
  }

  function hostLog(): string {
    return readFileSync(join(userData, "logs/host.log"), "utf8");
  }

  /** Quits through `app.quit()` and waits for the Electron process to end with exit code 0. */
  async function quit(l: Launched): Promise<void> {
    const proc = l.app.process();
    const exit = new Promise<number | null>((res) => proc.once("exit", (code) => res(code)));
    await l.app.evaluate(({ app }) => app.quit()).catch(() => {});
    const code = await Promise.race([exit, sleep(60_000).then(() => "timeout" as const)]);
    check(code === 0, `app.quit() ended the app with exit code ${code}`);
  }

  return {
    appBundle,
    root,
    needles,
    dataRoot,
    userData,
    keyFile,
    homeDir,
    loginItemFile,
    settingsFile,
    fakeStateDir,
    fakeCli,
    launched,
    launchEnv,
    launch,
    devices,
    hostOf,
    gone,
    nothingRemains,
    hostLog,
    quit,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      info(`removed ${root} and ${homeDir}`);
    },
  };
}
