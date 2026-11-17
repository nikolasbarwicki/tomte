import { app } from "electron";

import { fileLoginItem, LOGIN_ITEM_FILE_ENV, type LoginItem } from "./login-item.ts";

/** Marks a start the login item made, on platforms that do not report it (`wasOpenedAtLogin` is macOS only). */
const HIDDEN_FLAG = "--hidden";

const osLoginItem: LoginItem = {
  get: () => app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin,
  set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_FLAG] }),
  openedAtLogin: () =>
    process.argv.includes(HIDDEN_FLAG) || app.getLoginItemSettings().wasOpenedAtLogin,
};

/** The OS login item, or the file named by TOMTE_DESKTOP_LOGIN_ITEM_FILE when it is set (see `LOGIN_ITEM_FILE_ENV`). */
export function createLoginItem(env: NodeJS.ProcessEnv = process.env): LoginItem {
  const file = env[LOGIN_ITEM_FILE_ENV];
  if (!file) return osLoginItem;
  const recorded = fileLoginItem(file);
  return { ...recorded, openedAtLogin: () => process.argv.includes(HIDDEN_FLAG) };
}
