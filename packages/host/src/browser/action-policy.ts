import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Engine action names the host itself runs. Everything else is denied by the engine, even if a host tool
 * layer has a bug. The engine matches policies on its own action names (`evaluate`, `cookies_set`,
 * `state_save`, ...), not on categories such as "eval" or "network"; a deny list of categories is silently
 * ignored, so this is a default-deny allow list. A feature that needs another engine action adds it here.
 */
const ALLOWED_ACTIONS = [
  "launch",
  "close",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "scroll",
  "scrollintoview",
  "screenshot",
  "gettext",
  "tab_list",
  "tab_new",
  "tab_switch",
  "tab_close",
  "back",
  "viewport",
  "stream_status",
  // `auth login` is checked as `auth_login`, and again for the credential plugin it asks.
  "auth_login",
  "plugin:claudebot:credential.read",
] as const;

/** Spelled out as well, so the intent survives someone widening the allow list. */
const DENIED_ACTIONS = [
  "evaluate",
  "download",
  "upload",
  "route",
  "requests",
  "har_start",
  "har_stop",
  "state_save",
  "state_load",
  "cookies_get",
  "cookies_set",
  "cookies_clear",
  "storage_get",
  "storage_set",
  "storage_clear",
] as const;

export const ACTION_POLICY = { default: "deny", allow: ALLOWED_ACTIONS, deny: DENIED_ACTIONS };

/** Writes the policy where the engine can read it; the caller owns the returned directory. */
export function writeActionPolicy(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "claudebot-browser-"));
  const file = join(dir, "action-policy.json");
  writeFileSync(file, JSON.stringify(ACTION_POLICY), { mode: 0o600 });
  return { dir, file };
}
