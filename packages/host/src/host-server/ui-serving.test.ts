import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { directoryAssets } from "../ui/index.ts";

const INDEX =
  '<!doctype html><div id="root"></div><script type="module" src="/assets/app-1a2b3c.js"></script>';
const SECRET = "outside the asset directory";

let root: string;
let host: HandoffHost;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ui-test-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "app-1a2b3c.js"), "export const app = 1;");
  writeFileSync(join(dist, "assets", "style-4d5e6f.css"), "body{margin:0}");
  writeFileSync(join(root, "secret.txt"), SECRET);
  host = await startHandoffHost([], directoryAssets(dist));
});
afterEach(async () => {
  await host.stop();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) => fetch(`${host.clientUrl}${path}`, init);

describe("the web UI on the client listener", () => {
  test("a router path loads the app, so a reload on a deep link works", async () => {
    for (const path of ["/", "/bots/3f2a?panel=files", "/oauth/callback/", "/settings/devices"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe(INDEX);
    }
  });

  test("a registered route still wins over the app", async () => {
    const res = await get("/oauth/callback?code=x&state=unknown");
    expect(await res.text()).not.toBe(INDEX);
  });

  test("an asset is served with its content type and cached for good", async () => {
    const js = await get("/assets/app-1a2b3c.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe("export const app = 1;");

    const css = await get("/assets/style-4d5e6f.css");
    expect(css.headers.get("content-type")).toStartWith("text/css");
    expect(await css.text()).toBe("body{margin:0}");
  });

  test("HEAD answers the headers without a body", async () => {
    const res = await get("/assets/app-1a2b3c.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String("export const app = 1;".length));
    expect(await res.text()).toBe("");
  });

  test("a missing file answers 404 instead of the app", async () => {
    for (const path of ["/assets/nope.js", "/favicon.ico", "/assets/missing/deep.css"])
      expect((await get(path)).status).toBe(404);
  });

  test("a path cannot reach files outside the asset directory", async () => {
    for (const path of [
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/%2e%2e%5csecret.txt",
      "/secret.txt%00.js",
    ]) {
      const res = await get(path);
      expect(await res.text()).not.toContain(SECRET);
      expect(res.status).not.toBe(200);
    }
  });

  test("only GET and HEAD load the app, and /api/* never does", async () => {
    const post = await get("/bots/3f2a", {
      method: "POST",
      headers: { "content-type": "application/json", origin: host.clientUrl },
      body: "{}",
    });
    expect(post.status).toBe(404);
    const api = await get("/api/nope", { headers: host.authHeaders });
    expect(api.headers.get("content-type")).not.toStartWith("text/html");
    expect(await api.text()).not.toBe(INDEX);
    expect((await get("/api/nope")).status).toBe(401);
  });

  test("every UI response forbids inline and foreign code and framing, so injected markup can neither run nor frame the takeover controls", async () => {
    for (const path of [
      "/bots/3f2a?panel=browser",
      "/",
      "/assets/app-1a2b3c.js",
      "/assets/style-4d5e6f.css",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const policy = directives(res.headers.get("content-security-policy"));
      expect(policy.get("script-src")).toEqual(["'self'"]);
      expect(policy.get("style-src")).toEqual(["'self'"]);
      expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
      expect(policy.get("object-src")).toEqual(["'none'"]);
      expect(policy.get("base-uri")).toEqual(["'none'"]);
      expect(policy.get("connect-src")).toEqual(["'self'"]);
      expect(policy.get("form-action")).toEqual(["'self'"]);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("live view frames may load as data: images and nothing else is loosened", async () => {
    const policy = directives((await get("/")).headers.get("content-security-policy"));
    expect(policy.get("img-src")).toEqual(["'self'", "data:"]);
    expect([...policy.values()].flat()).not.toContain("'unsafe-inline'");
    expect([...policy.values()].flat()).not.toContain("'unsafe-eval'");
    expect([...policy.values()].flat()).not.toContain("*");
  });
});

/** The policy's directives by name, each as its list of sources. */
function directives(policy: string | null): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const part of (policy ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) parsed.set(name, sources);
  }
  return parsed;
}
