import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SkillInfo = { name: string; description: string };

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The folder holding skill folders: a `skills` subfolder when the source has one, else the source itself. */
const skillsRoot = (source: string) =>
  isDir(join(source, "skills")) ? join(source, "skills") : source;

/** `description` from SKILL.md front matter, including folded and literal block values. */
function describe(skillMd: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (!fm) return "";
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith("description:"));
  if (i < 0) return "";
  let value = lines[i]!.slice("description:".length).trim();
  const block = /^[>|][+-]?$/.test(value);
  if (block || value === "") {
    const rest: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      rest.push(l.trim());
    }
    value = rest.filter(Boolean).join(" ");
  }
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** Every folder under the source that holds a SKILL.md, sorted by name. Throws a user-readable message when the source is missing. */
export function scanSkills(source: string): SkillInfo[] {
  if (!isDir(source)) throw new Error(`skills folder not found: ${source}`);
  const root = skillsRoot(source);
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")))
    .map((e) => ({
      name: e.name,
      description: describe(readFileSync(join(root, e.name, "SKILL.md"), "utf8")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rebuilds `<pluginsDir>/<name>` holding copies of only `enabled` skill folders and returns its path.
 * With none enabled, removes the folder and returns undefined, so no plugin is passed to the session.
 */
export function buildPlugin(
  pluginsDir: string,
  name: string,
  source: string,
  enabled: string[],
): string | undefined {
  const dest = join(pluginsDir, name);
  rmSync(dest, { recursive: true, force: true });
  if (!enabled.length) return undefined;
  const root = skillsRoot(source);
  mkdirSync(join(dest, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dest, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.0.0", description: `Skills of the ${name} integration` }),
  );
  for (const skill of enabled)
    cpSync(join(root, skill), join(dest, "skills", skill), { recursive: true, dereference: true });
  return dest;
}

export type GitClone = (repo: string, dest: string) => Promise<void>;

/** Shallow clone into a sibling temp folder, renamed into place once complete, so a failed clone leaves nothing behind. */
export const gitClone: GitClone = async (repo, dest) => {
  const tmp = `${dest}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(dest, ".."), { recursive: true });
  const p = Bun.spawn(["git", "clone", "--depth", "1", repo, tmp], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed: ${err.trim().split("\n").pop()}`);
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
};
