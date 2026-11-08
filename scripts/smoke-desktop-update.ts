import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { UPDATES_ENV } from "../packages/desktop/src/updates.ts";
import {
  check,
  createSmokeRun,
  describeProcess,
  fail,
  info,
  LAUNCH_TIMEOUT_MS,
  sleep,
  trayView,
  until,
} from "./desktop-smoke-kit.ts";

// Smoke test of the desktop app's auto-update, run for real against a packaged app and a feed served from this machine:
//   bun scripts/smoke-desktop-update.ts <old .app> <folder of a newer package:desktop run>
// Both come from `package:desktop --update-url http://127.0.0.1:<port>` (the same port; local verification builds only,
// never CI): the old app's app-update.yml names the loopback feed, and the newer run's folder holds the `latest-mac.yml`
// and zip that the fixture server hands out. Everything runs on a fresh temp root (file secrets, mock keychain, fake
// Claude CLI, login-item file seam). Checked: with the off-switch (what every other smoke sets) the feed sees no request;
// with it removed the app checks, finds the newer version, downloads it and logs the outcome, and keeps running whatever
// the outcome is (an unsigned macOS app is expected to be refused by Squirrel.Mac). Prints the app's desktop.log.
const ZIP_NAME = /\.zip$/;

async function main(): Promise<void> {
  const [oldApp, feedDir] = process.argv.slice(2);
  if (!oldApp || !feedDir)
    fail("usage: bun scripts/smoke-desktop-update.ts <old .app> <feed folder>");
  const feed = resolve(feedDir ?? "");
  const yml = readFileSync(
    join(resolve(oldApp ?? ""), "Contents/Resources/app-update.yml"),
    "utf8",
  );
  const url = /^url:\s*(\S+)/m.exec(yml)?.[1] ?? fail("the app's app-update.yml names no url");
  const feedUrl = new URL(url);
  if (feedUrl.hostname !== "127.0.0.1") fail(`the feed ${url} is not on loopback`);
  const metadata = join(feed, "latest-mac.yml");
  if (!existsSync(metadata)) fail(`${metadata} does not exist`);
  const newVersion = /^version:\s*(\S+)/m.exec(readFileSync(metadata, "utf8"))?.[1] ?? "?";

  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(feedUrl.port),
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      requests.push(`${req.method} /${path}${req.headers.has("range") ? " (range)" : ""}`);
      const file = join(feed, path);
      if (
        !path ||
        path.includes("..") ||
        !(
          existsSync(file) &&
          (path.endsWith(".yml") || ZIP_NAME.test(path) || path.endsWith(".blockmap"))
        )
      )
        return new Response("not found", { status: 404 });
      return new Response(Bun.file(file));
    },
  });

  const run = await createSmokeRun(oldApp, "claudebot-desktop-update-smoke-");
  const { launch, launchEnv, quit, nothingRemains, sweep, cleanup, userData, fakeCli, launched } =
    run;
  const desktopLog = () => {
    try {
      return readFileSync(join(userData, "logs/desktop.log"), "utf8");
    } catch {
      return "";
    }
  };
  console.log(`temp root ${run.root}`);
  console.log(`app       ${run.appBundle}`);
  console.log(`feed      ${url} serving ${feed} (newer version ${newVersion})`);

  try {
    console.log("\n[1] launch with the off-switch (as every smoke does): the feed sees nothing");
    check(launchEnv({})[UPDATES_ENV] === "off", `${UPDATES_ENV}=off is in the launch environment`);
    const off = await launch({ CLAUDE_PATH: fakeCli }, LAUNCH_TIMEOUT_MS);
    await until("the desktop log to say updates are off", 30_000, () =>
      /updates are off: /.test(desktopLog()),
    );
    info((desktopLog().match(/updates are off: .*/) ?? [""])[0]);
    await sleep(40_000);
    check(requests.length === 0, `no request reached the feed in 40s (saw ${requests.length})`);
    await quit(off);
    await nothingRemains("launch 1");

    console.log(
      "\n[2] launch with updates on: the check runs, the download happens, the app lives",
    );
    const on = await launch({ CLAUDE_PATH: fakeCli, [UPDATES_ENV]: "on" }, LAUNCH_TIMEOUT_MS);
    await until("the desktop log to say updates are on", 30_000, () =>
      /updates are on/.test(desktopLog()),
    );
    await until(`the update ${newVersion} to be found`, 150_000, () =>
      desktopLog().includes(`update ${newVersion} found`),
    );
    check(true, `the check found ${newVersion}`);
    const outcome = await until("the download to end", 120_000, () => {
      const text = desktopLog();
      if (text.includes(`update ${newVersion} downloaded`)) return "downloaded" as const;
      if (/update failed: /.test(text)) return "failed" as const;
      return undefined;
    });
    // On macOS the downloaded event is followed by Squirrel's verdict on the unsigned app; give it a moment to arrive.
    await sleep(15_000);
    const log = desktopLog();
    console.log("\n--- desktop.log (this run) ---");
    for (const line of log.split("\n").filter(Boolean)) console.log(`  ${line}`);
    console.log("--- end ---");
    info(`feed requests: ${requests.join(" | ")}`);
    info(`download outcome first seen: ${outcome}`);
    check(
      requests.some((r) => r.startsWith("GET /latest-mac.yml")),
      "the app asked the feed for latest-mac.yml",
    );
    check(
      requests.some((r) => ZIP_NAME.test(r.split(" ")[1] ?? "")),
      "the app downloaded the update zip",
    );
    check(
      log.includes("WARNING: the host reports version"),
      "the host's version was compared with the app's and the mismatch (the fixture app is 0.1.0-rc.1 over a 0.1.0 host) logged",
    );
    const state = await trayView(on);
    info(`tray after the update: ${state.items.map((i) => i.label ?? "-").join(" / ")}`);
    const stillRunning = await on.app
      .evaluate(({ app }) => app.getVersion())
      .catch(() => undefined);
    check(stillRunning !== undefined, `the app is still running (version ${stillRunning})`);
    check(run.hostOf(on.pid) !== undefined, "the sidecar host is still running");
    await quit(on);
    await nothingRemains("launch 2");
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    for (const p of sweep()) console.log(`  cleaned up leftover ${describeProcess(p)}`);
    await server.stop(true);
    await cleanup();
  }
}

try {
  await main();
  console.log("\nsmoke passed");
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
