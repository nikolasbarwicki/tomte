import { SESSION_COOKIE } from "@tomte/contract/sidecar";
import { BrowserWindow } from "electron";

import { windowChrome } from "./window-chrome.ts";

function messagePage(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>Tomte</title>
<style>html{height:100%;background:#111;color:#aaa;font:15px system-ui,sans-serif}body{height:100%;margin:0;display:grid;place-items:center}pre{max-width:80ch;white-space:pre-wrap;font:12px ui-monospace,monospace}body::before{content:"";position:fixed;inset:0 0 auto;height:env(titlebar-area-height,0px);-webkit-app-region:drag}</style>
<body><div>${html}</div></body>`,
  )}`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const STARTING_PAGE = messagePage("Starting&hellip;");

/** The one window, which shows a placeholder until the host is ready. The renderer has no Node, runs in the sandbox with context isolation and gets no preload script. On macOS the title strip is replaced by the traffic lights over the page (`windowChrome`); the placeholder pages keep a draggable strip under them. */
export function createWindow(show = true): BrowserWindow {
  const window = new BrowserWindow({
    show,
    width: 1280,
    height: 860,
    title: "Tomte",
    ...windowChrome(process.platform),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  showStarting(window);
  return window;
}

export function showStarting(window: BrowserWindow): void {
  void window.loadURL(STARTING_PAGE);
}

/** Signs the window's session in to the host at `clientUrl`. The cookie has no expiry, so it lives only as long as the app and never reaches disk. */
export async function signIn(
  window: BrowserWindow,
  clientUrl: string,
  token: string,
): Promise<void> {
  const url = new URL(clientUrl);
  await window.webContents.session.cookies.set({
    url: url.origin,
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: url.protocol === "https:",
  });
}

/** Replaces what the window shows with a message that the host is not running, with why. */
export async function showHostStopped(window: BrowserWindow, reason: string): Promise<void> {
  await window.loadURL(
    messagePage(
      `The Tomte host is not running.<br>Choose Restart host in the menu bar icon's menu.<pre>${escapeHtml(reason)}</pre>`,
    ),
  );
}
