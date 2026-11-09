import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "smoke-ui.ts");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "smoke-ui-test-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A script that appends its name to `ran` and ends with `body`. */
async function script(name: string, body: string) {
  const path = join(dir, `${name}.ts`);
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(dir, "ran"))}, "${name}\\n");\n${body}\n`,
  );
  return path;
}
async function run(...scripts: string[]) {
  await rm(join(dir, "ran"), { force: true });
  // A web build directory in the environment keeps the wrapper from building the UI.
  const child = Bun.spawn([process.execPath, WRAPPER, ...scripts], {
    env: { ...process.env, SMOKE_WEB_DIST: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const ran = (await readFile(join(dir, "ran"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  return { out, err, code, ran };
}

test("smokes run in order and the wrapper passes when every one does", async () => {
  const result = await run(await script("a", ""), await script("b", ""));
  expect(result.code).toBe(0);
  expect(result.ran).toEqual(["a", "b"]);
  expect(result.out).toContain("all 2 smokes passed");
});

test("the first failing smoke's status is the wrapper's, and nothing after it runs", async () => {
  const result = await run(
    await script("ok", ""),
    await script("bad", "process.exit(3);"),
    await script("never", ""),
  );
  expect(result.code).toBe(3);
  expect(result.ran).toEqual(["ok", "bad"]);
  expect(result.err).toContain("bad.ts failed (exit 3)");
  expect(result.out).not.toContain("passed");
});

test("a smoke killed by a signal is a failure too", async () => {
  const result = await run(await script("killed", 'process.kill(process.pid, "SIGKILL");'));
  expect(result.code).not.toBe(0);
  expect(result.ran).toEqual(["killed"]);
});
