import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createPathGuard, type PathGuard } from "./guard.ts";

let scratch: string;
let workspace: string;
let files: string;
let outside: string;
let guard: PathGuard;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
  workspace = join(scratch, "workspace");
  files = join(scratch, "bots", "dev", "files");
  outside = join(scratch, "bots", "other");
  for (const d of [workspace, files, outside]) mkdirSync(d, { recursive: true });
  guard = createPathGuard({ cwd: workspace, roots: [workspace, files] });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("the path guard", () => {
  test("lets file tools work in the workspace and the files folder, by relative or absolute path, in files that do not exist yet", () => {
    expect(guard("Write", { file_path: "notes/new.md", content: "x" })).toBeUndefined();
    expect(guard("Read", { file_path: join(workspace, "a.txt") })).toBeUndefined();
    expect(guard("Edit", { file_path: join(files, "report", "a.md") })).toBeUndefined();
    expect(guard("Grep", { pattern: "x", path: "." })).toBeUndefined();
    expect(guard("Glob", { pattern: "**/*.ts" })).toBeUndefined();
    expect(guard("NotebookEdit", { notebook_path: join(files, "n.ipynb") })).toBeUndefined();
  });

  test("refuses paths that leave the places through `..`, an absolute path, `~` or a sibling directory", () => {
    for (const file_path of [
      "../outside.txt",
      "notes/../../outside.txt",
      join(outside, "memory.md"),
      join(scratch, "claudebot.db"),
      "/etc/passwd",
      "~/.ssh/id_rsa",
      "~",
      "~root/x",
      `${workspace}-sibling/x`,
    ])
      expect(guard("Write", { file_path }), file_path).toContain("is outside");
    expect(guard("Read", { file_path: join(homedir(), "x") })).toContain("is outside");
    expect(guard("NotebookEdit", { notebook_path: "../n.ipynb" })).toContain("is outside");
  });

  test("names the path it refused, so the agent can see what to change", () => {
    expect(guard("Write", { file_path: "../x" })).toStartWith("../x is outside");
  });

  test("refuses a symlink in the workspace that points out, for a file and for a directory, and one to a file that does not exist yet", () => {
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
    symlinkSync(outside, join(workspace, "dir-link"));
    symlinkSync(join(outside, "later.txt"), join(workspace, "dangling"));

    expect(guard("Read", { file_path: "link.txt" })).toContain("is outside");
    expect(guard("Write", { file_path: "dir-link/new.txt" })).toContain("is outside");
    expect(guard("Grep", { pattern: "s", path: "dir-link" })).toContain("is outside");
    expect(guard("Write", { file_path: join(workspace, "dir-link", "deeper", "x") })).toContain(
      "is outside",
    );
    expect(guard("Write", { file_path: "dangling" })).toBeUndefined();
  });

  test("lets a symlink that stays inside the places through", () => {
    writeFileSync(join(files, "real.txt"), "r");
    symlinkSync(join(files, "real.txt"), join(workspace, "to-files.txt"));

    expect(guard("Read", { file_path: "to-files.txt" })).toBeUndefined();
  });

  test("checks the fixed start of a glob pattern as well as its path", () => {
    expect(guard("Glob", { pattern: "/etc/*.conf" })).toContain("is outside");
    expect(guard("Glob", { pattern: "../*/memory.md" })).toContain("is outside");
    expect(guard("Glob", { pattern: "/*" })).toContain("is outside");
    expect(guard("Glob", { pattern: "~/**/*.pem" })).toContain("is outside");
    expect(guard("Glob", { pattern: "*.md", path: outside })).toContain("is outside");
    expect(guard("Glob", { pattern: `${files}/**/*.md` })).toBeUndefined();
    expect(guard("Glob", { pattern: "../*", path: "sub" })).toBeUndefined();
  });

  test("refuses a path that is not a string, and ignores a path left out", () => {
    expect(guard("Write", { file_path: 42 })).toBe("Write.file_path must be a path string");
    expect(guard("Read", { file_path: { toString: "x" } })).toContain("must be a path string");
    expect(guard("Grep", { pattern: "x" })).toBeUndefined();
    expect(guard("Grep", { pattern: "x", path: null })).toBeUndefined();
    expect(guard("Write", undefined)).toBeUndefined();
  });

  test("leaves every tool that is not a file tool to the sandbox and the user", () => {
    expect(guard("Bash", { command: "cat /etc/passwd" })).toBeUndefined();
    expect(guard("WebFetch", { url: "file:///etc/passwd" })).toBeUndefined();
    expect(guard("mcp__github__search", { path: "/etc" })).toBeUndefined();
  });
});
