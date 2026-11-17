import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Smoke test of the desktop app's hidden title bar (macOS only), run for real against the packaged `.app`:
//   bun scripts/smoke-desktop-titlebar.ts [dist/desktop/Tomte-darwin-arm64/mac-arm64/Tomte.app]
// One launch on a fresh temp root (fake Claude CLI, file secrets, mock keychain, login-item file seam; see the kit). It
//   - reads the web UI's header and the real traffic lights' geometry (Accessibility frames of the three native buttons)
//     and asserts the lights sit inside the header, vertically centred, with no control or title under them, both with
//     the sidebar at its full stop and at its rail;
//   - reads `-webkit-app-region` of the header, of the sidebar strip and of every interactive control in the header;
//   - drives the NATIVE buttons through Accessibility (System Events, by this app's pid only): close (hides to the tray,
//     host alive), minimize, fullscreen, and posts real mouse events (a small Swift helper): a drag on the header moves
//     the window, ⌘B takes the sidebar to its rail and back without moving it;
//   - captures native window screenshots (`screencapture -l<CGWindowID>`, that one window only) and page screenshots;
//   - checks the host-stopped page (a draggable strip, nothing under the lights) and that the Connections window keeps
//     its standard title bar;
//   - opens the same host's web UI in a plain Chromium page (not Electron) and asserts it is unchanged: no inset, no
//     drag region.
// Without the Accessibility permission for the process that runs this, it falls back to Electron calls for the buttons,
// the mouse and the geometry (the lights' extent then comes from the Window Controls Overlay rect) and says so.
// Screenshots and the log go to .scratch/titlebar/. Never prints a token or cookie value.
import { chromium, type Page } from "playwright-core";

import { SESSION_COOKIE } from "../packages/contract/src/sidecar.ts";
import {
  check,
  clickTray,
  createSmokeRun,
  EVIDENCE_DIR,
  fail,
  info,
  LAUNCH_TIMEOUT_MS,
  sleep,
  until,
  alive,
  describeProcess,
  trayView,
  type Launched,
} from "./desktop-smoke-kit.ts";

const OUT_DIR = join(EVIDENCE_DIR, "titlebar");
/** Pixels of air required between the traffic lights and anything else in the header. */
const MARGIN = 4;
/** How far the lights' centre may be from the header's, in pixels. */
const CENTRE_TOLERANCE = 2;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Part {
  desc: string;
  box: Box;
  region: string;
}
interface HeaderMeasure {
  wco: { present: boolean; visible: boolean; rect: Box };
  rootFlag: boolean;
  sidebar: string | null;
  header: { box: Box; region: string; paddingLeft: number } | undefined;
  strip: { box: Box; region: string } | undefined;
  /** Every direct child of the header (title, trigger, actions), then every interactive descendant. */
  children: Part[];
  controls: Part[];
  /** Elements in the header that look clickable (pointer cursor) but are not under a no-drag ancestor. */
  clickableInDrag: string[];
}

/** Runs in the page (Electron's or the plain browser's): the header's geometry and `-webkit-app-region`. Self-contained, it is serialized. */
function measureHeader(): HeaderMeasure {
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const region = (el: Element): string => {
    const s = getComputedStyle(el);
    return s.getPropertyValue("-webkit-app-region") || s.getPropertyValue("app-region") || "";
  };
  const desc = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""}${
      el.getAttribute("aria-label") ? `"${el.getAttribute("aria-label")}"` : ""
    }`;
  const interactive =
    'a,button,input,select,textarea,summary,label,[role="button"],[role="combobox"],[role="menuitem"],[role="switch"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  const header = document.querySelector("header[data-titlebar]");
  const strip = document.querySelector('[data-slot="sidebar-inner"] [data-titlebar]');
  const overlay = navigator.windowControlsOverlay;
  const part = (el: Element): Part => ({ desc: desc(el), box: box(el), region: region(el) });
  return {
    wco: {
      present: overlay !== undefined,
      visible: overlay?.visible ?? false,
      rect: overlay
        ? (({ x, y, width, height }) => ({ x, y, width, height }))(overlay.getTitlebarAreaRect())
        : { x: 0, y: 0, width: 0, height: 0 },
    },
    rootFlag: document.documentElement.hasAttribute("data-wco"),
    sidebar:
      document.querySelector('[data-slot="sidebar"][data-stop]')?.getAttribute("data-stop") ?? null,
    header: header
      ? {
          box: box(header),
          region: region(header),
          paddingLeft: Number.parseFloat(getComputedStyle(header).paddingLeft),
        }
      : undefined,
    strip: strip ? { box: box(strip), region: region(strip) } : undefined,
    children: header ? [...header.children].map(part) : [],
    controls: header ? [...header.querySelectorAll(interactive)].map(part) : [],
    clickableInDrag: header
      ? [...header.querySelectorAll("*")]
          .filter(
            (el) =>
              getComputedStyle(el).cursor === "pointer" &&
              (getComputedStyle(el).getPropertyValue("-webkit-app-region") || "") !== "no-drag",
          )
          .map(desc)
      : [],
  };
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const grow = (b: Box, by: number): Box => ({
  x: b.x - by,
  y: b.y - by,
  width: b.width + 2 * by,
  height: b.height + 2 * by,
});

// ---- native helpers ------------------------------------------------------------------------------------------------

interface Native {
  /** True when Accessibility lets this process drive System Events and post mouse events. */
  accessible: boolean;
  mouse(...args: (string | number)[]): { ok: boolean; stderr: string };
}

function osascript(script: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["osascript", "-e", script]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** Runs System Events AppleScript against the process with this pid and nothing else. */
const systemEvents = (pid: number, body: string) =>
  osascript(
    `tell application "System Events" to tell (first process whose unix id is ${pid})\n${body}\nend tell`,
  );

const SUBROLES = {
  close: "AXCloseButton",
  minimize: "AXMinimizeButton",
  fullscreen: "AXFullScreenButton",
} as const;

/** Frames of the three native window buttons, in screen points. */
function nativeButtons(pid: number): { name: keyof typeof SUBROLES; box: Box }[] | undefined {
  const rows: { name: keyof typeof SUBROLES; box: Box }[] = [];
  for (const name of Object.keys(SUBROLES) as (keyof typeof SUBROLES)[]) {
    const r = systemEvents(
      pid,
      `set b to first button of window 1 whose subrole is "${SUBROLES[name]}"\nset {px, py} to position of b\nset {sw, sh} to size of b\nreturn (px as text) & " " & (py as text) & " " & (sw as text) & " " & (sh as text)`,
    );
    if (!r.ok) return undefined;
    const [x, y, width, height] = r.out.split(" ").map(Number) as [number, number, number, number];
    rows.push({ name, box: { x, y, width, height } });
  }
  return rows;
}

const clickNative = (pid: number, name: keyof typeof SUBROLES) =>
  systemEvents(pid, `click (first button of window 1 whose subrole is "${SUBROLES[name]}")`);

async function screenshots(l: Launched, name: string): Promise<void> {
  const source = await l.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getMediaSourceId(),
  );
  const id = source.split(":")[1] ?? fail(`unexpected media source id ${source}`);
  const native = join(OUT_DIR, `${name}-native.png`);
  const r = Bun.spawnSync(["screencapture", `-l${id}`, "-o", "-x", native]);
  check(
    r.exitCode === 0,
    `native window screenshot of window ${id} (CGWindowID) saved as ${native}`,
  );
  await l.page.screenshot({ path: join(OUT_DIR, `${name}-page.png`) });
}

const windowState = (l: Launched) =>
  l.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    return {
      bounds: w.getBounds(),
      content: w.getContentBounds(),
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      fullscreen: w.isFullScreen(),
      focused: w.isFocused(),
    };
  });

const frontmost = (l: Launched) =>
  l.app.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    app.focus({ steal: true });
  });

// ---- the geometry assertions ---------------------------------------------------------------------------------------

function assertHeader(
  label: string,
  m: HeaderMeasure,
  lights: Box | undefined,
  wcoRight: number,
): void {
  const header = m.header ?? fail(`${label}: no header[data-titlebar]`);
  check(
    m.wco.present && m.wco.visible && m.rootFlag,
    `${label}: Window Controls Overlay is visible and the root has data-wco`,
  );
  check(header.region === "drag", `${label}: header -webkit-app-region is "${header.region}"`);
  const wrong = m.controls.filter((c) => c.region !== "no-drag");
  check(
    wrong.length === 0 && m.controls.length > 0,
    `${label}: all ${m.controls.length} interactive header controls are no-drag (${m.controls.map((c) => `${c.desc}=${c.region}`).join(", ")})`,
  );
  check(
    m.clickableInDrag.length === 0,
    `${label}: nothing with a pointer cursor sits in the drag region (${m.clickableInDrag.join(", ") || "none"})`,
  );
  check(
    header.box.y === 8 && header.box.height === 40 && m.wco.rect.height === 56,
    `${label}: header is the sheet's ${header.box.height}px top row at y ${header.box.y} (8 + 40 + 8 = the ${m.wco.rect.height}px overlay)`,
  );
  const box = lights ?? { x: 0, y: 0, width: wcoRight, height: 0 };
  if (lights) {
    const centre = lights.y + lights.height / 2;
    check(
      lights.y >= header.box.y && lights.y + lights.height <= header.box.y + header.box.height,
      `${label}: traffic lights (y ${lights.y}..${lights.y + lights.height}) are inside the header (0..${header.box.height})`,
    );
    check(
      Math.abs(centre - (header.box.y + header.box.height / 2)) <= CENTRE_TOLERANCE,
      `${label}: lights centre y ${centre} vs header centre ${header.box.y + header.box.height / 2} (±${CENTRE_TOLERANCE})`,
    );
  }
  const zone = grow({ ...box, height: lights ? box.height : header.box.height }, MARGIN);
  const under = [...m.children, ...m.controls].filter(
    (p) => p.box.width > 0 && intersects(zone, p.box),
  );
  check(
    under.length === 0,
    `${label}: nothing in the header intersects the lights' area plus ${MARGIN}px (${under.map((p) => p.desc).join(", ") || "none"}; lights right edge ${box.x + box.width})`,
  );
}

// ---- main ----------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const run = await createSmokeRun(process.argv[2], "tomte-desktop-titlebar-smoke-");
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`temp root ${run.root}`);
  console.log(`app       ${run.appBundle}`);
  try {
    const mouseBin = join(run.root, "desktop-mouse");
    const compiled = Bun.spawnSync([
      "swiftc",
      "-O",
      join(import.meta.dir, "desktop-mouse.swift"),
      "-o",
      mouseBin,
    ]);
    const native: Native = {
      accessible: false,
      mouse: (...args) => {
        const r = Bun.spawnSync([mouseBin, ...args.map(String)]);
        return { ok: r.exitCode === 0, stderr: r.stderr.toString().trim() };
      },
    };
    if (compiled.exitCode === 0)
      native.accessible = Bun.spawnSync([mouseBin, "trusted"]).stdout.toString().trim() === "true";
    info(
      `Accessibility for this process: ${native.accessible ? "granted" : "NOT granted (Electron-call fallbacks are used and labelled)"}`,
    );

    console.log("\n[1] launch, the window and the header");
    const l = await run.launch({ CLAUDE_PATH: run.fakeCli }, LAUNCH_TIMEOUT_MS);
    // Float the window at a known frame and make sure it stays there: macOS can keep or restore a tiled frame for an app.
    const target = { x: 120, y: 90, width: 1280, height: 820 };
    let placed = false;
    for (let attempt = 1; attempt <= 5 && !placed; attempt++) {
      await l.app.evaluate(
        ({ BrowserWindow }, t) => BrowserWindow.getAllWindows()[0]!.setBounds(t),
        target,
      );
      await sleep(1500);
      placed = JSON.stringify((await windowState(l)).bounds) === JSON.stringify(target);
    }
    info(
      placed
        ? `window placed at ${JSON.stringify(target)} and it stayed`
        : `LIMIT: the OS did not keep the window at ${JSON.stringify(target)}; it is now ${JSON.stringify((await windowState(l)).bounds)}`,
    );
    await frontmost(l);
    await l.page.waitForSelector("header[data-titlebar]");
    await sleep(800);
    const prefs = await l.app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences()!;
      return {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
        webviewTag: p.webviewTag,
        preload: p.preload ?? null,
      };
    });
    info(`webPreferences ${JSON.stringify(prefs)}`);
    check(
      prefs.contextIsolation === true &&
        prefs.sandbox === true &&
        prefs.nodeIntegration === false &&
        prefs.webviewTag === false &&
        prefs.preload === null,
      "security settings unchanged: contextIsolation and sandbox on; nodeIntegration and webviewTag off; no preload",
    );
    // Raw CDP: Playwright's own evaluate wrapper defines a `require`, which says nothing about the page.
    const cdp = await l.page.context().newCDPSession(l.page);
    const globals: string[] = [];
    for (const name of ["process", "require", "module", "Buffer"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: `typeof ${name}` });
      globals.push(String(result.value));
    }
    check(
      globals.every((g) => g === "undefined"),
      `the renderer has no Node: typeof process/require/module/Buffer = ${globals.join("/")}`,
    );
    const win = await windowState(l);
    check(
      win.content.y === win.bounds.y,
      `the content starts at the window's top edge (no OS title strip): bounds.y ${win.bounds.y}, content.y ${win.content.y}`,
    );

    const lightsOf = async (): Promise<Box | undefined> => {
      if (!native.accessible) return undefined;
      const buttons = nativeButtons(l.pid);
      if (!buttons) return undefined;
      const ws = await windowState(l);
      const rects = buttons.map((b) => ({
        x: b.box.x - ws.content.x,
        y: b.box.y - ws.content.y,
        width: b.box.width,
        height: b.box.height,
      }));
      const x = Math.min(...rects.map((r) => r.x));
      const y = Math.min(...rects.map((r) => r.y));
      const right = Math.max(...rects.map((r) => r.x + r.width));
      const bottom = Math.max(...rects.map((r) => r.y + r.height));
      info(
        `native buttons (Accessibility, window coordinates): ${buttons.map((b, i) => `${b.name} ${JSON.stringify(rects[i])}`).join("; ")}`,
      );
      return { x, y, width: right - x, height: bottom - y };
    };

    const expanded = await l.page.evaluate(measureHeader);
    const lights = await lightsOf();
    if (!lights)
      info(
        "LIMIT: no Accessibility frames; the lights' right edge comes from the overlay rect and vertical centring is not measured natively",
      );
    assertHeader("expanded sidebar", expanded, lights, expanded.wco.rect.x);
    check(
      expanded.strip !== undefined &&
        expanded.strip.region === "drag" &&
        expanded.strip.box.height === 40 &&
        expanded.strip.box.y === 8,
      `the sidebar's top strip is a 40px drag region level with the header (${JSON.stringify(expanded.strip)})`,
    );
    check(
      expanded.sidebar === "full" && expanded.header!.paddingLeft === 12,
      `expanded: header padding-left is ${expanded.header!.paddingLeft}px (the lights sit over the sidebar strip)`,
    );
    await screenshots(l, "after");

    console.log("\n[2] the rail: ⌘B narrows the sidebar to its faces, the lights stay over it");
    const before = await windowState(l);
    await frontmost(l);
    await sleep(300);
    await l.page.keyboard.press("Meta+b");
    await until(
      "the sidebar to reach its rail",
      5000,
      async () => (await l.page.evaluate(measureHeader)).sidebar === "rail",
    );
    await sleep(500);
    const collapsed = await l.page.evaluate(measureHeader);
    const afterToggle = await windowState(l);
    check(
      JSON.stringify(afterToggle.bounds) === JSON.stringify(before.bounds),
      `⌘B took the sidebar to its ${collapsed.sidebar} and did not move or resize the window`,
    );
    assertHeader("sidebar rail", collapsed, await lightsOf(), collapsed.wco.rect.x);
    check(
      collapsed.header!.paddingLeft === 12,
      `rail: header padding-left is ${collapsed.header!.paddingLeft}px (the lights still sit over the sidebar)`,
    );
    await screenshots(l, "after-collapsed");

    console.log("\n[3] drag: a real drag on the header moves the window");
    const dragFrom = async (name: string, point: { x: number; y: number }) => {
      const start = await windowState(l);
      const hit = await l.page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const drag = el?.closest("[data-titlebar]");
        return {
          tag: el?.tagName ?? "",
          drag: drag ? getComputedStyle(drag).getPropertyValue("-webkit-app-region") || "" : "",
          own: el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || "" : "",
        };
      }, point);
      check(
        hit.drag === "drag" && hit.own !== "no-drag",
        `${name}: the point (${point.x}, ${point.y}) lands on ${hit.tag} inside a drag region`,
      );
      await frontmost(l);
      await sleep(300);
      const dx = 100;
      const dy = 60;
      if (native.accessible) {
        const r = native.mouse(
          "drag",
          Math.round(start.content.x + point.x),
          Math.round(start.content.y + point.y),
          Math.round(start.content.x + point.x + dx),
          Math.round(start.content.y + point.y + dy),
        );
        check(r.ok, `${name}: real mouse drag posted${r.stderr ? `: ${r.stderr}` : ""}`);
        await until(
          `${name}: the window to move`,
          5000,
          async () => (await windowState(l)).bounds.x !== start.bounds.x,
        );
        await sleep(300);
        const end = await windowState(l);
        check(
          Math.abs(end.bounds.x - (start.bounds.x + dx)) <= 2 &&
            Math.abs(end.bounds.y - (start.bounds.y + dy)) <= 2 &&
            end.bounds.width === start.bounds.width &&
            end.bounds.height === start.bounds.height,
          `${name}: getBounds moved by (${end.bounds.x - start.bounds.x}, ${end.bounds.y - start.bounds.y}) for a drag of (${dx}, ${dy}), size unchanged`,
        );
        native.mouse(
          "drag",
          Math.round(end.content.x + point.x),
          Math.round(end.content.y + point.y),
          Math.round(end.content.x + point.x - dx),
          Math.round(end.content.y + point.y - dy),
        );
        await sleep(400);
      } else {
        info(
          `LIMIT: ${name}: no Accessibility; only the app-region proof above stands, the window was not dragged`,
        );
      }
    };
    // An empty part of the header: well right of the trigger, on the title text's flex-1 box, not on a control.
    const headerBox = collapsed.header!.box;
    await dragFrom("header", {
      x: Math.round(headerBox.x + headerBox.width - 160),
      y: Math.round(headerBox.y + headerBox.height / 2),
    });
    // Back to the full sidebar so its strip can be dragged too.
    await l.page.keyboard.press("Meta+b");
    await until(
      "the sidebar to open again",
      5000,
      async () => (await l.page.evaluate(measureHeader)).sidebar === "full",
    );
    await sleep(500);
    await dragFrom("sidebar strip", { x: 150, y: 28 });

    console.log("\n[4] native buttons through Accessibility: minimize, fullscreen, close to tray");
    if (!native.accessible) {
      info(
        "LIMIT: no Accessibility; the buttons are exercised with the Electron calls the buttons map to",
      );
    }
    const press = async (name: keyof typeof SUBROLES, electron: () => Promise<unknown>) => {
      if (native.accessible) {
        const r = clickNative(l.pid, name);
        check(
          r.ok,
          `Accessibility click on the native ${name} button (AX${SUBROLES[name].slice(2)})${r.err ? `: ${r.err}` : ""}`,
        );
      } else await electron();
    };
    await frontmost(l);
    await sleep(300);
    await press("minimize", () =>
      l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize()),
    );
    await until("the window to be minimized", 8000, async () => (await windowState(l)).minimized);
    check(true, "isMinimized() is true after the native minimize");
    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
    await until("the window to be restored", 8000, async () => !(await windowState(l)).minimized);
    check(true, "restore() brings it back (an Electron call: the Dock is not clicked)");
    await frontmost(l);
    await sleep(500);

    const preFullscreen = (await windowState(l)).bounds;
    await press("fullscreen", () =>
      l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true)),
    );
    await until("fullscreen", 10_000, async () => (await windowState(l)).fullscreen);
    await sleep(2000);
    const full = await l.page.evaluate(measureHeader);
    info(
      `fullscreen measure: wco ${JSON.stringify(full.wco)} root data-wco ${full.rootFlag}; strip ${JSON.stringify(full.strip?.box)}; header ${JSON.stringify(full.header)}`,
    );
    check(
      full.strip !== undefined && full.strip.box.height === 0,
      `in fullscreen the sidebar strip collapses to ${full.strip?.box.height}px: no useless gap where the lights were`,
    );
    check(
      full.header!.paddingLeft === 12,
      `in fullscreen the header keeps its plain ${full.header!.paddingLeft}px padding`,
    );
    await screenshots(l, "after-fullscreen");
    // Leave fullscreen with the real green button when the OS lets it find the (hover-revealed) button, else with the Electron call.
    const left = native.accessible
      ? clickNative(l.pid, "fullscreen")
      : { ok: false, err: "no Accessibility" };
    if (!left.ok)
      await l.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setFullScreen(false),
      );
    info(
      left.ok
        ? "left fullscreen with the native button"
        : `left fullscreen with setFullScreen(false) (native button: ${left.err})`,
    );
    await until("fullscreen to end", 10_000, async () => !(await windowState(l)).fullscreen);
    await sleep(2000);
    const back = await l.page.evaluate(measureHeader);
    check(
      back.wco.visible && back.rootFlag && back.strip?.box.height === 40,
      "after fullscreen the overlay, data-wco and the 40px strip are back",
    );
    const restored = await windowState(l);
    check(
      JSON.stringify(restored.bounds) === JSON.stringify(preFullscreen) && !restored.fullscreen,
      `the window is back at its size and place before fullscreen ${JSON.stringify(restored.bounds)}`,
    );
    await frontmost(l);
    await sleep(500);

    const hostPid = run.hostOf(l.pid)?.pid ?? fail("no host process is a child of the app");
    await press("close", () =>
      l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()),
    );
    await until("the window to be hidden", 10_000, async () => !(await windowState(l)).visible);
    const view = await trayView(l);
    check(
      !view.visible && alive(l.pid) && alive(hostPid) && view.status === "running",
      `native close hid the window to the tray: visible ${view.visible}, app pid ${l.pid} and host pid ${hostPid} alive, tray says ${view.status}`,
    );
    await clickTray(l, "Open Tomte");
    await until("the window to be shown again", 10_000, async () => (await windowState(l)).visible);
    check(true, 'tray "Open Tomte" shows the window again');
    await frontmost(l);
    await sleep(500);

    console.log("\n[5] the shell's own pages and the Connections window");
    process.kill(hostPid, "SIGKILL");
    await until("the host-stopped page", 15_000, () =>
      l.page.evaluate(() => document.body.innerText.includes("not running")).catch(() => false),
    );
    await sleep(500);
    const stopped = await l.page.evaluate(() => {
      const before = getComputedStyle(document.body, "::before");
      const text = document.querySelector("body > div")!.getBoundingClientRect();
      const overlay = navigator.windowControlsOverlay!.getTitlebarAreaRect();
      return {
        region: before.getPropertyValue("-webkit-app-region"),
        height: Number.parseFloat(before.height),
        top: text.top,
        left: text.left,
        lightsRight: overlay.x,
        overlayHeight: overlay.height,
      };
    });
    info(`host-stopped page ${JSON.stringify(stopped)}`);
    check(
      stopped.region === "drag" &&
        stopped.height === stopped.overlayHeight &&
        stopped.height === 56,
      `the host-stopped page has a ${stopped.height}px drag strip (${stopped.region})`,
    );
    check(
      stopped.top >= stopped.overlayHeight || stopped.left >= stopped.lightsRight,
      `its message (top ${Math.round(stopped.top)}, left ${Math.round(stopped.left)}) is clear of the lights' area`,
    );
    await screenshots(l, "after-host-stopped");
    await clickTray(l, "Restart host");
    await until("the UI after the host restart", 60_000, () =>
      l.page
        .evaluate(() => document.querySelector("header[data-titlebar]") !== null)
        .catch(() => false),
    );
    await sleep(800);

    await clickTray(l, "Manage Connections…");
    const connections = await until("the Connections window", 10_000, () =>
      l.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Connections");
        return w ? { bounds: w.getBounds(), content: w.getContentBounds(), id: w.id } : undefined;
      }),
    );
    check(
      connections.content.y > connections.bounds.y,
      `the Connections window keeps the standard title bar (content ${connections.content.y - connections.bounds.y}px below its top)`,
    );
    await l.app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(),
      connections.id,
    );
    await sleep(500);

    console.log("\n[6] the same web UI in a plain Chromium page (not Electron)");
    const cookies = await l.app.evaluate(
      ({ BrowserWindow }, name) =>
        BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({ name }),
      SESSION_COOKIE,
    );
    const session = cookies[0] ?? fail("the app window has no session cookie");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // The host restarted since launch, so its client URL is the window's current origin, not l.clientUrl.
      const origin = new URL(l.page.url()).origin;
      await context.addCookies([{ name: session.name, value: session.value, url: origin }]);
      const tab: Page = await context.newPage();
      await tab.goto(origin);
      await tab.waitForSelector("header[data-titlebar]");
      await sleep(500);
      const web = await tab.evaluate(measureHeader);
      info(
        `browser measure ${JSON.stringify({ wco: web.wco, rootFlag: web.rootFlag, header: web.header, strip: web.strip })}`,
      );
      check(
        !web.rootFlag && !web.wco.visible,
        `browser: no data-wco flag, overlay present ${web.wco.present} visible ${web.wco.visible}`,
      );
      check(
        web.header!.region === "none" &&
          web.strip!.region === "none" &&
          web.controls.every((c) => c.region === "none"),
        `browser: -webkit-app-region is none on the header (${web.header!.region}), the strip (${web.strip!.region}) and all ${web.controls.length} controls`,
      );
      check(
        web.strip!.box.height === 0,
        `browser: the sidebar strip has ${web.strip!.box.height}px height`,
      );
      check(
        web.header!.paddingLeft === 12 && web.header!.box.height === 40,
        `browser: header padding-left ${web.header!.paddingLeft}px, height ${web.header!.box.height}px`,
      );
      await tab.screenshot({ path: join(OUT_DIR, "after-browser.png") });
      await tab.keyboard.press("Meta+b");
      await sleep(600);
      const webCollapsed = await tab.evaluate(measureHeader);
      check(
        webCollapsed.sidebar === "rail" &&
          webCollapsed.header!.paddingLeft === 12 &&
          webCollapsed.header!.box.x === 76,
        `browser, sidebar rail: header padding-left ${webCollapsed.header!.paddingLeft}px, header at x ${webCollapsed.header!.box.x}`,
      );
      await tab.screenshot({ path: join(OUT_DIR, "after-browser-collapsed.png") });
    } finally {
      await browser.close();
    }

    console.log("\n[7] quit");
    await run.quit(l);
    await run.nothingRemains("the quit launch");
  } finally {
    for (const app of run.launched) await app.close().catch(() => {});
    for (const p of run.sweep()) console.log(`  cleaned up leftover ${describeProcess(p)}`);
    await run.cleanup();
  }
}

try {
  await main();
  console.log("\nsmoke passed");
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
