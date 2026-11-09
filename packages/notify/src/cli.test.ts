import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExternalEventInput } from "@claudebot/contract/api";

import { EXIT, run, type Context } from "./cli.ts";
import { TOKEN_VAR, URL_VAR } from "./config.ts";

const TOKEN = "synthetic-token-for-tests-only";
const MAIN = join(import.meta.dir, "main.ts");

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  text: string;
  /** The request body as the host's schema reads it; a body the schema refuses fails the test with the issue. */
  json: ExternalEventInput;
}

type Answer = (req: Request) => Response | Promise<Response>;

const posted = (id = "e1", duplicate = false) =>
  Response.json({ id, duplicate }, { status: duplicate ? 200 : 202 });

const servers: { stop(close?: boolean): unknown }[] = [];
function serve(answer: Answer = () => posted()) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = await req.text();
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        text,
        json: ExternalEventInput.parse(JSON.parse(text)),
      });
      return answer(req);
    },
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${server.port}/api/bots/b1/events` };
}

let root: string;
let home: string;
let work: string;
beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "notify-cli-"));
  home = join(root, "home");
  work = join(root, "work");
  mkdirSync(join(home, ".config", "claudebot"), { recursive: true });
  mkdirSync(work);
});
afterAll(() => {
  for (const server of servers) void server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** One run in a temp HOME and a plain directory, with what it printed. */
async function sender(
  argv: string[],
  env: Record<string, string | undefined>,
  over: Partial<Context> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env: { PATH: process.env.PATH, ...env },
    cwd: work,
    home,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  });
  const printed = [...out, ...err].join("\n");
  expect(printed).not.toContain(TOKEN);
  return { code, out, err, printed };
}

const viaEnv = (url: string) => ({ [URL_VAR]: url, [TOKEN_VAR]: TOKEN });

describe("one report, one request", () => {
  test.each([
    ["progress", "progress"],
    ["question", "question"],
    ["blocked", "blocked"],
    ["completed", "done"],
    ["failed", "failed"],
  ])(
    "%s becomes a %s event with the bot's token in the Authorization header only",
    async (word, kind) => {
      const fixture = serve();
      const r = await sender(
        [word, "04-notify", "omp-7", 'wave 1 of 2 "done"'],
        viaEnv(fixture.url),
      );
      expect(r).toMatchObject({ code: EXIT.ok, out: ["ok"], err: [] });
      expect(fixture.seen).toHaveLength(1);
      const [request] = fixture.seen;
      expect(request).toMatchObject({
        method: "POST",
        path: "/api/bots/b1/events",
        authorization: `Bearer ${TOKEN}`,
        contentType: "application/json",
      });
      expect(request!.json).toMatchObject({
        kind,
        title: 'wave 1 of 2 "done"',
        body: "Task: 04-notify\nSession: omp-7",
        source: { label: "04-notify" },
      });
      expect(request!.text).not.toContain(TOKEN);
    },
  );

  test("a question id travels with the report", async () => {
    const fixture = serve();
    await sender(["question", "t", "s", "Which one?", "Q-04-1"], viaEnv(fixture.url));
    expect(fixture.seen[0]!.json.title).toBe("Which one?");
    expect(fixture.seen[0]!.json.body).toBe("Task: t\nSession: s\nQuestion ID: Q-04-1");
  });

  test("the same report sent twice is the same event; --salt makes it a new one", async () => {
    const fixture = serve();
    const argv = ["failed", "t", "s", "disk full"];
    await sender(argv, viaEnv(fixture.url));
    await sender(argv, viaEnv(fixture.url));
    await sender(["--salt", "second try", ...argv], viaEnv(fixture.url));
    const [a, b, c] = fixture.seen.map((s) => s.json.key);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  test("a duplicate answer is a success", async () => {
    const fixture = serve(() => posted("e1", true));
    const r = await sender(["progress", "t", "s", "again"], viaEnv(fixture.url));
    expect(r).toMatchObject({ code: EXIT.ok, out: ["ok (duplicate)"], err: [] });
  });

  test("a message may start with a dash, and `--` ends the options", async () => {
    const fixture = serve();
    await sender(["progress", "t", "s", "--not-an-option"], viaEnv(fixture.url));
    await sender(["--salt", "x", "--", "progress", "t", "s", "-- tail"], viaEnv(fixture.url));
    expect(fixture.seen.map((s) => s.json.title)).toEqual(["--not-an-option", "-- tail"]);
  });
});

describe("a reply target", () => {
  const target = { kind: "herdr", agent: "coord", session: "s1" };

  test("--reply and --reply-session become the event's reply, and the question id becomes structured", async () => {
    const fixture = serve();
    const r = await sender(
      ["--reply", "herdr:coord", "--reply-session", "s1", "question", "t", "s", "Which?", "Q-1"],
      viaEnv(fixture.url),
    );
    expect(r.code).toBe(EXIT.ok);
    expect(fixture.seen[0]!.json).toMatchObject({ reply: target, questionId: "Q-1" });
    expect(fixture.seen[0]!.json.body).toContain("Question ID: Q-1");
  });

  test("the environment names it too, and a flag wins", async () => {
    const fixture = serve();
    const env = {
      ...viaEnv(fixture.url),
      CLAUDEBOT_REPLY: "herdr:from-env",
      CLAUDEBOT_REPLY_SESSION: "s9",
    };
    await sender(["question", "t", "s", "m", "Q-1"], env);
    await sender(["--reply", "herdr:from-flag", "question", "t", "s", "m", "Q-1"], env);
    expect(fixture.seen.map((s) => s.json.reply)).toEqual([
      { kind: "herdr", agent: "from-env", session: "s9" },
      { kind: "herdr", agent: "from-flag", session: "s9" },
    ]);
  });

  test("an agent name may contain a colon: the kind is what comes before the first one", async () => {
    const fixture = serve();
    await sender(["--reply", "herdr:team:lead", "question", "t", "s", "m"], viaEnv(fixture.url));
    expect(fixture.seen[0]!.json.reply).toEqual({ kind: "herdr", agent: "team:lead" });
  });

  test("without a reply target nothing structured is sent, whatever the question id looks like", async () => {
    const fixture = serve();
    await sender(["question", "t", "s", "m", "free form id with spaces"], viaEnv(fixture.url));
    expect(fixture.seen[0]!.json.reply).toBeUndefined();
    expect(fixture.seen[0]!.json.questionId).toBeUndefined();
  });

  test("the same report with and without a reply target is two events", async () => {
    const fixture = serve();
    await sender(["question", "t", "s", "m", "Q-1"], viaEnv(fixture.url));
    await sender(["--reply", "herdr:coord", "question", "t", "s", "m", "Q-1"], viaEnv(fixture.url));
    await sender(["--reply", "herdr:coord", "question", "t", "s", "m", "Q-1"], viaEnv(fixture.url));
    const [bare, first, again] = fixture.seen.map((s) => s.json.key);
    expect(first).not.toBe(bare);
    expect(again).toBe(first);
  });

  test.each([
    ["a kind and no agent", ["--reply", "herdr", "question", "t", "s", "m"], "--reply must be"],
    ["an empty agent", ["--reply", "herdr:", "question", "t", "s", "m"], "--reply must be"],
    [
      "an agent starting with a dash",
      ["--reply", "herdr:-x", "question", "t", "s", "m"],
      "--reply must be",
    ],
    [
      "a kind in capitals",
      ["--reply", "Herdr:coord", "question", "t", "s", "m"],
      "--reply must be",
    ],
    [
      "an agent with a space",
      ["--reply", "herdr:a b", "question", "t", "s", "m"],
      "--reply must be",
    ],
    [
      "a session with a dash first",
      ["--reply", "herdr:coord", "--reply-session", "-s", "question", "t", "s", "m"],
      "--reply must be",
    ],
    [
      "a session without a target",
      ["--reply-session", "s1", "question", "t", "s", "m"],
      "--reply-session needs --reply",
    ],
    ["--reply without a value", ["--reply"], "--reply needs a value"],
    [
      "a question id the reply cannot carry",
      ["--reply", "herdr:coord", "question", "t", "s", "m", "Q 1"],
      "question_id must be a name",
    ],
    [
      "a question id starting with a dash",
      ["--reply", "herdr:coord", "question", "t", "s", "m", "-Q"],
      "question_id must be a name",
    ],
  ])("%s exits 2 and sends nothing", async (_name, argv, problem) => {
    const fixture = serve();
    const r = await sender(argv, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.usage);
    expect(r.err[0]).toContain(problem);
    expect(fixture.seen).toHaveLength(0);
  });
});

describe("usage", () => {
  const cases: [string, string[], string][] = [
    ["no arguments", [], "expected a kind"],
    ["missing message", ["progress", "t", "s"], "expected a kind"],
    ["unknown kind", ["done", "t", "s", "m"], 'unknown kind "done"'],
    ["too many arguments", ["progress", "t", "s", "m", "q", "extra"], "too many arguments"],
    ["empty task", ["progress", "", "s", "m"], "task_id must not be empty"],
    ["multi-line session", ["progress", "t", "a\nb", "m"], "session_id must be one line"],
    ["empty question id", ["question", "t", "s", "m", " "], "question_id must not be empty"],
    ["blank message", ["progress", "t", "s", " \n "], "message must not be empty"],
    ["unknown option", ["--json", "progress", "t", "s", "m"], "unknown option --json"],
    ["--salt without a value", ["--salt"], "--salt needs a value"],
    [
      "--salt with an empty value",
      ["--salt", "", "progress", "t", "s", "m"],
      "--salt needs a value",
    ],
  ];
  test.each(cases)("%s exits 2 with the usage and sends nothing", async (_name, argv, problem) => {
    const fixture = serve();
    const r = await sender(argv, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.usage);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toContain(`claudebot-notify: ${problem}`);
    expect(r.err.join("\n")).toContain("usage: claudebot-notify");
    expect(fixture.seen).toHaveLength(0);
  });

  test("usage is reported before the configuration is looked at", async () => {
    const r = await sender(["bogus"], {});
    expect(r.code).toBe(EXIT.usage);
  });

  test("--help prints the usage and exits 0", async () => {
    const r = await sender(["--help"], {});
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("<progress|question|blocked|completed|failed>");
  });
});

describe("configuration", () => {
  const send = ["progress", "t", "s", "m"];

  test("a missing config file exits 1 and says what to create", async () => {
    const r = await sender(send, {});
    expect(r.code).toBe(EXIT.config);
    expect(r.err[0]).toContain("missing config");
    expect(r.err[0]).toContain(join(home, ".config", "claudebot", "notify.env"));
  });

  test("a partial environment pair exits 1, and nothing is sent", async () => {
    const fixture = serve();
    const r = await sender(send, { [URL_VAR]: fixture.url });
    expect(r.code).toBe(EXIT.config);
    expect(r.err[0]).toContain(`${TOKEN_VAR} is not set`);
    expect(fixture.seen).toHaveLength(0);
  });

  test("a config file is used, and its project files the report under that project", async () => {
    const fixture = serve();
    const file = join(root, "explicit.env");
    writeFileSync(file, `export ${URL_VAR}="${fixture.url}"\n${TOKEN_VAR}=${TOKEN}\n`, {
      mode: 0o600,
    });
    const r = await sender(send, {
      CLAUDEBOT_NOTIFY_ENV: file,
      CLAUDEBOT_NOTIFY_PROJECT: "claudebot",
    });
    expect(r).toMatchObject({ code: EXIT.ok, out: ["ok"], err: [] });
    expect(fixture.seen[0]).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(fixture.seen[0]!.json.source.label).toBe("claudebot · t");
  });

  test("a file others can read still sends, with a warning that names the path only", async () => {
    const fixture = serve();
    const file = join(root, "loose.env");
    writeFileSync(file, `${URL_VAR}=${fixture.url}\n${TOKEN_VAR}=${TOKEN}\n`, { mode: 0o644 });
    const r = await sender(send, { CLAUDEBOT_NOTIFY_ENV: file });
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toEqual([
      `claudebot-notify: warning: ${file} can be read by other users; run chmod 600 on it`,
    ]);
  });

  test("--which prints the file in use, or `environment`, and reads no token", async () => {
    const file = join(root, "which.env");
    expect(await sender(["--which"], { CLAUDEBOT_NOTIFY_ENV: file })).toMatchObject({
      code: EXIT.ok,
      out: [file],
    });
    expect(await sender(["--which"], viaEnv("http://127.0.0.1:1/x"))).toMatchObject({
      code: EXIT.ok,
      out: ["environment"],
    });
    expect((await sender(["--which"], {})).out).toEqual([
      join(home, ".config", "claudebot", "notify.env"),
    ]);
    expect((await sender(["--which"], { [URL_VAR]: "u" })).code).toBe(EXIT.config);
  });
});

describe("failures", () => {
  const send = ["blocked", "t", "s", "stuck"];

  test("a rejected event exits 3 with the status and the host's own words", async () => {
    const fixture = serve(() => Response.json({ error: "title: Too big" }, { status: 400 }));
    const r = await sender(send, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.request);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual([
      `claudebot-notify: HTTP 400 from ${new URL(fixture.url).origin}: title: Too big`,
    ]);
  });

  test("a 401 adds a hint, and a server that echoes the token does not make it print", async () => {
    const fixture = serve((req) =>
      Response.json(
        { error: `invalid event token ${req.headers.get("authorization")}` },
        { status: 401 },
      ),
    );
    const r = await sender(send, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.request);
    expect(r.err[0]).toContain("HTTP 401");
    expect(r.err[0]).toContain("[redacted]");
    expect(r.err[0]).toContain("rotated token");
  });

  test("a body that is not JSON is shown as one clean bounded line, token and control characters removed", async () => {
    const fixture = serve(
      () =>
        new Response(`<html>\u001b[31m bad gateway\n${TOKEN}\n${"x".repeat(1000)}`, {
          status: 502,
        }),
    );
    const r = await sender(send, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.request);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain("HTTP 502");
    expect(r.err[0]).toContain("[redacted]");
    expect(r.err[0]).not.toContain("\u001b");
    expect(r.err[0]!.length).toBeLessThan(450);
  });

  test("an empty error body still names the status", async () => {
    const fixture = serve(() => new Response(null, { status: 503 }));
    const r = await sender(send, viaEnv(fixture.url));
    expect(r.err).toEqual([`claudebot-notify: HTTP 503 from ${new URL(fixture.url).origin}`]);
  });

  test("a redirect is a failure and is not followed, so the token goes nowhere else", async () => {
    const elsewhere = serve();
    const fixture = serve(
      () => new Response(null, { status: 307, headers: { location: elsewhere.url } }),
    );
    const r = await sender(send, viaEnv(fixture.url));
    expect(r.code).toBe(EXIT.request);
    expect(r.err[0]).toContain("HTTP 307");
    expect(elsewhere.seen).toHaveLength(0);
  });

  test("a 2xx that is not an events route's answer exits 3", async () => {
    for (const body of [
      () => new Response("<html>ok</html>", { status: 200 }),
      () => Response.json({ ok: 1 }, { status: 202 }),
    ]) {
      const fixture = serve(body);
      const r = await sender(send, viaEnv(fixture.url));
      expect(r.code).toBe(EXIT.request);
      expect(r.err[0]).toContain("not an events route's answer");
    }
  });

  test("no answer in time exits 3", async () => {
    const fixture = serve(() => new Promise<Response>(() => {}));
    const r = await sender(send, viaEnv(fixture.url), { timeoutMs: 100 });
    expect(r.code).toBe(EXIT.request);
    expect(r.err[0]).toContain("no answer within 0s");
  });

  test("an unreachable loopback host exits 3 and points at the sandbox", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const { port } = closed;
    await closed.stop(true);
    const r = await sender(send, viaEnv(`http://127.0.0.1:${port}/api/bots/b1/events`));
    expect(r.code).toBe(EXIT.request);
    expect(r.err[0]).toContain(`could not reach http://127.0.0.1:${port}`);
    expect(r.err[0]).toContain("ADR-0007");
  });

  test("an unreachable remote host does not mention the sandbox", async () => {
    const r = await sender(send, viaEnv("http://notify-host.invalid/api/bots/b1/events"), {
      timeoutMs: 3000,
    });
    expect(r.code).toBe(EXIT.request);
    expect(r.err[0]).toContain("could not reach http://notify-host.invalid");
    expect(r.err[0]).not.toContain("sandbox");
  });
});

describe("as a program", () => {
  const spawn = (script: string, argv: string[], env: Record<string, string>) =>
    Bun.spawn([process.execPath, script, ...argv], {
      cwd: work,
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("the entry point sends, prints ok and exits 0; through a symlink named claudebot-notify too", async () => {
    const fixture = serve();
    const link = join(root, "claudebot-notify");
    symlinkSync(MAIN, link);
    for (const script of [MAIN, link]) {
      const child = spawn(script, ["completed", "t", "s", "shipped"], viaEnv(fixture.url));
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ out, err, code }).toEqual({ out: "ok\n", err: "", code: 0 });
    }
    expect(fixture.seen.map((s) => s.json.kind)).toEqual(["done", "done"]);
  });

  test("the entry point exits with the code of the failure and puts the message on stderr", async () => {
    const fixture = serve(() => Response.json({ error: "nope" }, { status: 401 }));
    const child = spawn(MAIN, ["failed", "t", "s", "m"], viaEnv(fixture.url));
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(EXIT.request);
    expect(out).toBe("");
    expect(err).toContain("HTTP 401");
    expect(err).not.toContain(TOKEN);
  });

  test("the token is not on the command line of the process", async () => {
    const fixture = serve();
    const child = spawn(MAIN, ["progress", "t", "s", "m"], viaEnv(fixture.url));
    await child.exited;
    expect(fixture.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Bun.argv.join(" ")).not.toContain(TOKEN);
  });
});
