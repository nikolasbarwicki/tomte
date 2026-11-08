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
