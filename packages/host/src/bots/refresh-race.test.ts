import { afterEach, beforeEach, expect, setDefaultTimeout, test, describe } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BILLING_ENV,
  createClaudeAccess,
  isAuthFailure,
  type ClaudeAccess,
} from "../harness/index.ts";
import { parseHostConfig } from "../platform/config.ts";
import { Thread } from "./thread.ts";

// Every start launches a process.
setDefaultTimeout(60_000);

const FAKE_CLAUDE = join(import.meta.dir, "..", "testing", "fake-claude.ts");

let dir: string;
let accesses: ClaudeAccess[] = [];
let threads: Thread[] = [];

beforeEach(() => {
  for (const k of BILLING_ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "refresh-race-"));
  mkdirSync(join(dir, "fake"));
});

afterEach(() => {
  for (const t of threads) t.close();
  for (const a of accesses) a.close();
  threads = [];
  accesses = [];
  rmSync(dir, { recursive: true, force: true });
});

/** The fake Claude CLI, run through a wrapper that names its state directory. */
function fakeCli() {
  const path = join(dir, "claude-fake");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} ${JSON.stringify(join(dir, "fake"))} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return { path, source: "CLAUDE_PATH", needsShell: false } as const;
}

function openAccess(cli: ReturnType<typeof fakeCli>) {
  const config = parseHostConfig(
    ["--data-root", join(dir, "data")],
    {},
    { platform: "linux", home: dir },
  ).config;
  const access = createClaudeAccess(config, cli);
  accesses.push(access);
  return access;
}

describe("two logins refreshing at once (fake CLI simulation)", () => {
  const fake = (name: string) => join(dir, "fake", name);
  const log = () =>
    existsSync(fake("oauth-log.jsonl"))
      ? readFileSync(fake("oauth-log.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { at: string; outcome: string })
      : [];

  /** The fake's sign-in holds one rotating refresh token; its access token is good for the current epoch. */
  function signIn(epoch: { credentials: number; now: number }) {
    writeFileSync(fake("oauth.json"), JSON.stringify({ refreshMs: 150 }));
    writeFileSync(
      fake("oauth-credentials.json"),
      JSON.stringify({ refresh: "r1", epoch: epoch.credentials }),
    );
    writeFileSync(fake("oauth-epoch"), String(epoch.now));
  }
  const expire = () => writeFileSync(fake("oauth-epoch"), "2");

  /** Two bots on one host: each has its own thread, as each has its own live CLI. */
  function bots(access: ClaudeAccess, env?: () => Promise<Record<string, string>>) {
    const cli = fakeCli();
    return [1, 2].map((n) => {
      const thread = new Thread({
        cli,
        claude: access,
        cwd: dir,
        approveAll: true,
        delegate: { askUser: async () => "", approve: async () => ({ behavior: "allow" }) },
        memory: { user: join(dir, "user.md"), bot: join(dir, `bot-${n}.md`) },
        log: () => {},
        ...(env && { env }),
      });
      threads.push(thread);
      return thread;
    });
  }
  const gated = () => openAccess(fakeCli());
  const ungated = (): ClaudeAccess => ({ ...gated(), startGate: (start) => start() });

  test("two bots starting together with an expired token: one refresh, both start", async () => {
    signIn({ credentials: 1, now: 2 });
    const [a, b] = bots(gated());
    const results = await Promise.allSettled([a!.send("hi"), b!.send("hi")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(log()).toEqual([{ at: "start", outcome: "refreshed" }]);
  });

  test("without the gate the second start presents a refresh token the first just used", async () => {
    signIn({ credentials: 1, now: 2 });
    const [a, b] = bots(ungated());
    const results = await Promise.allSettled([a!.send("hi"), b!.send("hi")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(
      log()
        .map((l) => l.outcome)
        .sort(),
    ).toEqual(["refreshed", "rejected"]);
  });

  test("two running sessions whose tokens expire together: the gate cannot help, one turn fails", async () => {
    signIn({ credentials: 1, now: 1 });
    const [a, b] = bots(gated());
    await Promise.all([a!.send("first"), b!.send("first")]);
    expect(log()).toEqual([]);

    expire();
    const results = await Promise.allSettled([a!.send("second"), b!.send("second")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isAuthFailure(failure.reason)).toBe(true);
    expect(log()).toEqual(
      expect.arrayContaining([
        { at: "turn", outcome: "refreshed" },
        { at: "turn", outcome: "rejected" },
      ]),
    );
    expect(log()).toHaveLength(2);

    // The failed bot's next turn reopens its CLI, which reads the credentials the other one wrote.
    const failed = results[0]!.status === "rejected" ? a! : b!;
    expect((await failed.send("third")).text).toBe("ok");
    expect(log()).toHaveLength(2);
  });

  test("with a long-lived token in the CLI's environment neither session refreshes", async () => {
    signIn({ credentials: 1, now: 1 });
    const [a, b] = bots(gated(), async () => ({ CLAUDE_CODE_OAUTH_TOKEN: "long-lived" }));
    await Promise.all([a!.send("first"), b!.send("first")]);
    expire();
    const results = await Promise.allSettled([a!.send("second"), b!.send("second")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(log()).toEqual([]);
  });
});
