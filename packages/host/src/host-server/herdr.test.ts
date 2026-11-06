import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { watchHerdr } from "./herdr.ts";

let dir: string;
let server: Server;
let stop: (() => void) | undefined;
const saved = process.env.HERDR_SOCKET_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-"));
  process.env.HERDR_SOCKET_PATH = join(dir, "herdr.sock");
});
afterEach(() => {
  stop?.();
  server.close();
  if (saved === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** A herdr socket that lists one pane and then sends `events` on the subscription. */
function serve(events: string[]): Promise<void> {
  server = createServer((sock: Socket) => {
    createInterface({ input: sock }).on("line", (line) => {
      const { method } = JSON.parse(line);
      if (method === "pane.list")
        return void sock.write(
          JSON.stringify({ result: { panes: [{ pane_id: "p1", cwd: "/w" }] } }) + "\n",
        );
      sock.write(JSON.stringify({ result: {} }) + "\n");
      for (const e of events) sock.write(e + "\n");
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(process.env.HERDR_SOCKET_PATH, resolve);
  return promise;
}

test("a status change herdr reports becomes a notice", async () => {
  await serve([
    JSON.stringify({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent: "omp", agent_status: "done" },
    }),
  ]);
  const notice = Promise.withResolvers<string>();
  stop = watchHerdr(
    (title, body) => notice.resolve(`${title} | ${body}`),
    () => {},
  );
  expect(await notice.promise).toBe("omp finished | p1 · /w");
});

test("a line that breaks herdr's protocol is logged, not thrown", async () => {
  await serve(["not json"]);
  const logged = Promise.withResolvers<string>();
  const notices: string[] = [];
  stop = watchHerdr(
    (title) => notices.push(title),
    (l) => logged.resolve(l),
  );
  expect(await logged.promise).toBe("herdr: herdr sent a line that is not JSON");
  expect(notices).toEqual([]);
});
