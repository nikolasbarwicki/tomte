import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

/** When this names a file, the login item is recorded there as `{ "openAtLogin": boolean }` and the OS is never asked: the seam smoke tests use so nothing registers on the machine they run on. */
export const LOGIN_ITEM_FILE_ENV = "TOMTE_DESKTOP_LOGIN_ITEM_FILE";

/** The app's registration with the OS to open when the user logs in. */
export interface LoginItem {
  get(): boolean;
  set(open: boolean): void;
  /** True when the OS started this process because of the login item, which then starts hidden in the tray. */
  openedAtLogin(): boolean;
}

const Recorded = z.object({ openAtLogin: z.boolean() });

/** A login item that lives in a JSON file. A missing or unreadable file is "not registered". */
export function fileLoginItem(file: string): LoginItem {
  return {
    get() {
      try {
        return Recorded.parse(JSON.parse(readFileSync(file, "utf8"))).openAtLogin;
      } catch {
        return false;
      }
    },
    set(open) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ openAtLogin: open })}\n`);
    },
    openedAtLogin: () => false,
  };
}
