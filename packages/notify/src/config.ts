import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** The two variables that name a bot's events route; the environment of a bot's harness and a config file use the same names. */
export const URL_VAR = "TOMTE_EVENTS_URL";
export const TOKEN_VAR = "TOMTE_EVENTS_TOKEN";

/** A problem with the configuration. The message names a file, a variable or a line number, never a value. */
export class ConfigError extends Error {}

/** What the sender needs to know about its surroundings; every input is explicit so tests need no real HOME or repository. */
export interface Surroundings {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
}

/** Where the URL and token come from: the process environment, or one config file. */
export type Source = { from: "environment" } | { from: "file"; path: string };

export interface Selection {
  source: Source;
  /** The project slug the report is filed under (after `routes`), when one could be told. */
  project?: string;
}

export interface Config {
  url: URL;
  token: string;
}

const set = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The output of `--which`: the file's path, or the word `environment`. */
export const describeSource = (source: Source): string =>
  source.from === "environment" ? "environment" : source.path;

const isFileNamePart = (slug: string) => !/[/\\\0]/.test(slug) && slug !== "." && slug !== "..";

/** The directory of notify config: `TOMTE_NOTIFY_DIR`, else `tomte/` under `XDG_CONFIG_HOME` or `~/.config`. */
function configDir({ env, home }: Surroundings): string {
  if (set(env.TOMTE_NOTIFY_DIR)) return env.TOMTE_NOTIFY_DIR;
  return join(set(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config"), "tomte");
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The main repository's name when `cwd` is in a git repository or one of its worktrees; `undefined` outside any. */
async function repositoryName(cwd: string, env: Surroundings["env"]): Promise<string | undefined> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) defined[name] = value;
  try {
    const git = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      env: defined,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
    const common = out.trim();
    return code === 0 && common !== "" ? basename(dirname(common)) : undefined;
  } catch {
    return undefined;
  }
}

/** The first path segment under `<home>/.herdr/worktrees/`, for a directory that is no git checkout. */
function worktreeName({ cwd, home }: Surroundings): string | undefined {
  const root = `${join(home, ".herdr", "worktrees")}/`;
  return cwd.startsWith(root) ? cwd.slice(root.length).split("/")[0] || undefined : undefined;
}

/** `repo=slug` lines of the `routes` file in the config dir: the slug a repository's reports are filed under. First match wins; other lines are ignored. */
async function routed(dir: string, project: string): Promise<string> {
  const text = await readFile(join(dir, "routes"), "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 0 || line.trimStart().startsWith("#")) continue;
    if (line.slice(0, at).trim() === project) return line.slice(at + 1).trim() || project;
  }
  return project;
}

/**
 * Which config the report uses, decided without reading it. In order:
 * 1. `TOMTE_NOTIFY_ENV`: that file, for a caller that names its target outright.
 * 2. `TOMTE_EVENTS_URL` and `TOMTE_EVENTS_TOKEN` in the environment, which is what a bot's harness has. One
 *    without the other is an error, never a fallback to a file.
 * 3. `notify-<project>.env` in the config dir when it exists, else `notify.env` there. The project is
 *    `TOMTE_NOTIFY_PROJECT`, else the name of the main repository of the working directory (a worktree resolves to
 *    its main repository), else the first path segment under `~/.herdr/worktrees/`; the `routes` file remaps it.
 */
export async function select(s: Surroundings): Promise<Selection> {
  const { env } = s;
  const dir = configDir(s);
  let project = env.TOMTE_NOTIFY_PROJECT;
  project = set(project) ? project : ((await repositoryName(s.cwd, env)) ?? worktreeName(s));
  if (project !== undefined) project = await routed(dir, project);
  const named = { ...(project !== undefined && { project }) };

  if (set(env.TOMTE_NOTIFY_ENV))
    return { source: { from: "file", path: resolve(s.cwd, env.TOMTE_NOTIFY_ENV) }, ...named };
  const url = set(env[URL_VAR]);
  if (url !== set(env[TOKEN_VAR]))
    throw new ConfigError(
      `${url ? TOKEN_VAR : URL_VAR} is not set, but ${url ? URL_VAR : TOKEN_VAR} is`,
    );
  if (url) return { source: { from: "environment" }, ...named };

  if (project !== undefined && !isFileNamePart(project))
    throw new ConfigError(`project "${project}" cannot name a config file`);
  const own = project === undefined ? undefined : join(dir, `notify-${project}.env`);
  const path = own !== undefined && (await exists(own)) ? own : join(dir, "notify.env");
  return { source: { from: "file", path }, ...named };
}

/**
 * A config file read as data. Lines are `KEY=VALUE` with an optional leading `export `; blank lines and `#` lines are
 * skipped; a value may be wrapped in one pair of single or double quotes, which are removed. Nothing is expanded or
 * unescaped and nothing runs. Keys other than the two this sender reads are ignored. A bad line is an error that
 * names its number and nothing of its content.
 */
export function parseEnvFile(text: string, path: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new ConfigError(`${path} line ${i + 1}: expected KEY=VALUE`);
    let value = m[2]!.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || !value.endsWith(quote))
        throw new ConfigError(`${path} line ${i + 1}: unbalanced quote`);
      value = value.slice(1, -1);
    }
    values.set(m[1]!, value);
  }
  return values;
}

/** The URL and the token, checked: an http(s) URL with no credentials in it, and a token that is a plain header value. */
function validate(url: string, token: string, where: string): Config {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${URL_VAR} in ${where} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ConfigError(`${URL_VAR} in ${where} must be an http or https URL`);
  if (parsed.username !== "" || parsed.password !== "")
    throw new ConfigError(
      `${URL_VAR} in ${where} must not carry credentials; the token has its own variable`,
    );
  if (!/^[\x21-\x7e]+$/.test(token))
    throw new ConfigError(`${TOKEN_VAR} in ${where} must be visible characters without spaces`);
  return { url: parsed, token };
}

/** The URL and token of a selected source. A file that others can read is used, with a warning for the caller to show. */
export async function load(
  source: Source,
  env: Surroundings["env"],
): Promise<{ config: Config; warning?: string }> {
  if (source.from === "environment")
    return { config: validate(env[URL_VAR] ?? "", env[TOKEN_VAR] ?? "", "the environment") };

  const { path } = source;
  let text: string;
  let mode: number;
  try {
    [text, mode] = await Promise.all([readFile(path, "utf8"), stat(path).then((s) => s.mode)]);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "error";
    if (code === "ENOENT")
      throw new ConfigError(
        `missing config ${path}: create it with ${URL_VAR}= and ${TOKEN_VAR}= (see docs/notify.md), or set both in the environment`,
      );
    throw new ConfigError(`cannot read ${path}: ${code}`);
  }
  const values = parseEnvFile(text, path);
  const url = values.get(URL_VAR);
  const token = values.get(TOKEN_VAR);
  if (!set(url)) throw new ConfigError(`${URL_VAR} is missing in ${path}`);
  if (!set(token)) throw new ConfigError(`${TOKEN_VAR} is missing in ${path}`);
  const warning =
    (mode & 0o077) === 0 || process.platform === "win32"
      ? undefined
      : `${path} can be read by other users; run chmod 600 on it`;
  return { config: validate(url, token, path), ...(warning !== undefined && { warning }) };
}
