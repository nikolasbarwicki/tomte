import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  describeSource,
  load,
  parseEnvFile,
  select,
  TOKEN_VAR,
  URL_VAR,
  type Surroundings,
} from "./config.ts";

const TOKEN = "synthetic-token-for-tests-only";
const URL_ = "http://127.0.0.1:9/api/bots/b1/events";

let root: string;
let home: string;
let dir: string;
/** Directories to run from: inside a repository, in one of its worktrees, in a Herdr worktree that is no checkout, and outside everything. */
let place: { repo: string; repoSub: string; worktree: string; herdr: string; elsewhere: string };

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
};

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "notify-config-"));
  home = join(root, "home");
  dir = join(home, ".config", "tomte");
  const repo = join(root, "src", "my-repo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(repo, "pkg"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(root, "elsewhere", "feature-tree");
  mkdirSync(join(root, "elsewhere"));
  git(repo, "worktree", "add", "-q", worktree);
  const herdr = join(home, ".herdr", "worktrees", "herd-project", "task-1", "deep");
  mkdirSync(herdr, { recursive: true });
  const elsewhere = join(root, "plain");
  mkdirSync(elsewhere);
  place = { repo, repoSub: join(repo, "pkg"), worktree, herdr, elsewhere };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const around = (cwd: string, env: Record<string, string> = {}): Surroundings => ({
  cwd,
  home,
  env: {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...env,
  },
});

const write = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
};
const clean = () => {
  for (const name of ["notify.env", "notify-my-repo.env", "notify-herd-project.env", "routes"])
    rmSync(join(dir, name), { force: true });
};

describe("which config is selected", () => {
  test("the URL and token in the environment select the environment, whatever files exist", async () => {
    clean();
    write("notify.env", `${URL_VAR}=${URL_}\n${TOKEN_VAR}=${TOKEN}\n`);
    const picked = await select(around(place.repo, { [URL_VAR]: URL_, [TOKEN_VAR]: TOKEN }));
    expect(describeSource(picked.source)).toBe("environment");
    expect(picked.project).toBe("my-repo");
  });

  test("one of the two variables without the other is an error, never a fallback to a file", async () => {
    clean();
    write("notify.env", `${URL_VAR}=${URL_}\n${TOKEN_VAR}=${TOKEN}\n`);
    await expect(select(around(place.repo, { [URL_VAR]: URL_ }))).rejects.toThrow(
      `${TOKEN_VAR} is not set, but ${URL_VAR} is`,
    );
    await expect(select(around(place.repo, { [TOKEN_VAR]: TOKEN }))).rejects.toThrow(
      `${URL_VAR} is not set, but ${TOKEN_VAR} is`,
    );
    const empty = around(place.repo, { [URL_VAR]: "", [TOKEN_VAR]: "" });
    expect(describeSource((await select(empty)).source)).toBe(join(dir, "notify.env"));
  });

  test("an explicit file wins over the environment and the project; a relative one is made absolute", async () => {
    const env = { TOMTE_NOTIFY_ENV: "mine.env", [URL_VAR]: URL_, [TOKEN_VAR]: TOKEN };
    const picked = await select(around(place.elsewhere, env));
    expect(describeSource(picked.source)).toBe(join(place.elsewhere, "mine.env"));
    const named = await select(
      around(place.repo, { TOMTE_NOTIFY_ENV: "/abs/x.env", TOMTE_NOTIFY_PROJECT: "p" }),
    );
    expect(describeSource(named.source)).toBe("/abs/x.env");
  });

  test("a repository, its subdirectory and its worktree all route to the main repository's file", async () => {
    clean();
    const own = write("notify-my-repo.env", "");
    for (const cwd of [place.repo, place.repoSub, place.worktree]) {
      const picked = await select(around(cwd));
      expect(describeSource(picked.source)).toBe(own);
      expect(picked.project).toBe("my-repo");
    }
  });

  test("a Herdr worktree that is no checkout routes by the first segment under ~/.herdr/worktrees", async () => {
    clean();
    const own = write("notify-herd-project.env", "");
    const picked = await select(around(place.herdr));
    expect(describeSource(picked.source)).toBe(own);
    expect(picked.project).toBe("herd-project");
  });

  test("the project variable wins over the repository, and a project without a file falls back to notify.env", async () => {
    clean();
    const own = write("notify-my-repo.env", "");
    const fallback = join(dir, "notify.env");
    const other = await select(around(place.repo, { TOMTE_NOTIFY_PROJECT: "other" }));
    expect(describeSource(other.source)).toBe(fallback);
    expect(other.project).toBe("other");
    const same = await select(around(place.elsewhere, { TOMTE_NOTIFY_PROJECT: "my-repo" }));
    expect(describeSource(same.source)).toBe(own);
  });

  test("outside any repository and project the fallback file is selected, with no project", async () => {
    clean();
    const picked = await select(around(place.elsewhere));
    expect(describeSource(picked.source)).toBe(join(dir, "notify.env"));
    expect(picked.project).toBeUndefined();
  });

  test("the routes file remaps a repository to another slug: first match wins, comments and bad lines are skipped", async () => {
    clean();
    write("routes", "# repo=slug\nnonsense\nother=x\nmy-repo = shared\nmy-repo=ignored\n");
    const shared = write("notify-shared.env", "");
    const picked = await select(around(place.worktree));
    expect(describeSource(picked.source)).toBe(shared);
    expect(picked.project).toBe("shared");
    rmSync(shared);
  });

  test("the config directory can be moved with TOMTE_NOTIFY_DIR or XDG_CONFIG_HOME", async () => {
    clean();
    const moved = join(root, "moved");
    mkdirSync(moved, { recursive: true });
    const viaDir = await select(around(place.elsewhere, { TOMTE_NOTIFY_DIR: moved }));
    expect(describeSource(viaDir.source)).toBe(join(moved, "notify.env"));
    const viaXdg = await select(around(place.elsewhere, { XDG_CONFIG_HOME: moved }));
    expect(describeSource(viaXdg.source)).toBe(join(moved, "tomte", "notify.env"));
  });

  test("a project name that cannot be part of a file name is refused", async () => {
    for (const name of ["../escape", "a/b", ".."])
      await expect(select(around(place.elsewhere, { TOMTE_NOTIFY_PROJECT: name }))).rejects.toThrow(
        "cannot name a config file",
      );
  });
});

describe("a config file is data", () => {
  test("reads KEY=VALUE lines, quotes, export and comments, and expands and runs nothing", () => {
    const values = parseEnvFile(
      [
        "# a comment",
        "",
        `export ${URL_VAR}="${URL_}"`,
        `${TOKEN_VAR}='${TOKEN}'`,
        "OTHER=$(touch /tmp/should-not-exist) `id` $HOME \\n",
      ].join("\r\n"),
      "f.env",
    );
    expect(values.get(URL_VAR)).toBe(URL_);
    expect(values.get(TOKEN_VAR)).toBe(TOKEN);
    expect(values.get("OTHER")).toBe("$(touch /tmp/should-not-exist) `id` $HOME \\n");
  });

  test("a bad line is an error that names its number and none of its content", () => {
    const secret = "tok-should-never-be-printed";
    for (const text of [`ok=1\nnot a pair ${secret}`, `K="${secret}`, `1BAD=${secret}`]) {
      let message = "";
      try {
        parseEnvFile(text, "/p/notify.env");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^\/p\/notify\.env line \d+: /);
      expect(message).not.toContain(secret);
    }
  });
});

describe("loading the selected config", () => {
  const file = (text: string, mode = 0o600) => {
    const path = join(root, "load.env");
    writeFileSync(path, text);
    chmodSync(path, mode);
    return { from: "file", path } as const;
  };
  const good = `${URL_VAR}=${URL_}\n${TOKEN_VAR}=${TOKEN}\n`;
  const message = async (promise: Promise<unknown>) =>
    promise.then(
      () => "",
      (e: Error) => (e instanceof ConfigError ? e.message : `unexpected ${e}`),
    );

  test("a file gives its URL and token; keys the sender does not read are ignored", async () => {
    const { config, warning } = await load(file(`WEBHOOK_URL=x\n${good}WEBHOOK_KEY=y\n`), {});
    expect(config.url.href).toBe(URL_);
    expect(config.token).toBe(TOKEN);
    expect(warning).toBeUndefined();
  });

  test("the environment gives its URL and token", async () => {
    const { config } = await load({ from: "environment" }, { [URL_VAR]: URL_, [TOKEN_VAR]: TOKEN });
    expect(config.url.href).toBe(URL_);
    expect(config.token).toBe(TOKEN);
  });

  test("a file others can read is used and flagged, naming the path and not the token", async () => {
    const { config, warning } = await load(file(good, 0o644), {});
    expect(config.token).toBe(TOKEN);
    expect(warning).toContain("load.env");
    expect(warning).toContain("chmod 600");
    expect(warning).not.toContain(TOKEN);
  });

  test("a missing file says where to set it up; an unreadable one names its path and the error code", async () => {
    const missing = join(root, "nope.env");
    expect(await message(load({ from: "file", path: missing }, {}))).toBe(
      `missing config ${missing}: create it with ${URL_VAR}= and ${TOKEN_VAR}= (see docs/notify.md), or set both in the environment`,
    );
    expect(await message(load({ from: "file", path: root }, {}))).toBe(
      `cannot read ${root}: EISDIR`,
    );
    const loop = join(root, "loop.env");
    symlinkSync(loop, loop);
    expect(await message(load({ from: "file", path: loop }, {}))).toMatch(
      /^cannot read .*: ELOOP$/,
    );
  });

  test("a missing or invalid URL or token is refused without echoing a value", async () => {
    expect(await message(load(file(`${TOKEN_VAR}=${TOKEN}`), {}))).toBe(
      `${URL_VAR} is missing in ${join(root, "load.env")}`,
    );
    expect(await message(load(file(`${URL_VAR}=${URL_}`), {}))).toBe(
      `${TOKEN_VAR} is missing in ${join(root, "load.env")}`,
    );
    expect(await message(load(file(`${URL_VAR}=not a url\n${TOKEN_VAR}=${TOKEN}`), {}))).toContain(
      `${URL_VAR} in `,
    );
    expect(await message(load(file(`${URL_VAR}=ftp://h/x\n${TOKEN_VAR}=${TOKEN}`), {}))).toContain(
      "must be an http or https URL",
    );
    const withCredentials = `${URL_VAR}=http://user:${TOKEN}@h/x\n${TOKEN_VAR}=${TOKEN}`;
    const refused = await message(load(file(withCredentials), {}));
    expect(refused).toContain("must not carry credentials");
    expect(refused).not.toContain(TOKEN);
    const spaced = await message(load(file(`${URL_VAR}=${URL_}\n${TOKEN_VAR}="a b"`), {}));
    expect(spaced).toContain("visible characters without spaces");
    expect(spaced).not.toContain("a b");
  });
});
