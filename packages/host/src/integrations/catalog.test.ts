import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CATALOG } from "./catalog.ts";

const WEB_PUBLIC = fileURLToPath(new URL("../../../web/public", import.meta.url));

test("every built-in has a logo, and every image logo is a file the web app ships", () => {
  for (const c of CATALOG) {
    expect(c.icon, `${c.id} has no icon`).toBeDefined();
    if (c.icon && "image" in c.icon)
      expect(existsSync(`${WEB_PUBLIC}${c.icon.image}`), `${c.id}: ${c.icon.image}`).toBe(true);
  }
});

const stepsOf = (id: string) => {
  const auth = CATALOG.find((c) => c.id === id)?.auth;
  return auth && "ownClient" in auth && auth.ownClient ? auth.ownClient : undefined;
};

test("Gmail needs no preview enrolment, while the Google services on hosted MCP servers still do, and every Google service shares one client", () => {
  const gmail = stepsOf("gmail");
  expect(gmail?.scope).toBe("https://www.googleapis.com/auth/gmail.modify");
  expect(gmail?.steps.join("\n")).not.toMatch(/Developer Preview|MCP API|AI-powered/);
  for (const id of ["google-calendar", "google-sheets", "google-docs", "google-drive"]) {
    expect(stepsOf(id)?.steps.join("\n"), id).toMatch(/Developer Preview/);
    expect(stepsOf(id)?.appLabel, id).toBe(gmail?.appLabel);
  }
});
