import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, dirname } from "node:path";
import { resolveInside } from "../bots/index.ts";

/** Why `name` cannot be handed over from `srcDir`, or undefined when it is a regular file inside it. */
function refusal(srcDir: string, name: string): string | undefined {
  if (!name || isAbsolute(name)) return `"${name}" is not a name inside your files folder`;
  const abs = resolveInside(srcDir, name);
  if (!abs) return `"${name}" is outside your files folder`;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return `"${name}" does not exist in your files folder`;
  }
  const rel = relative(realpathSync(srcDir), real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `"${name}" is outside your files folder`;
  return statSync(real).isFile() ? undefined : `"${name}" is not a file`;
}

/** Copies `names` from the assignee's files folder into `<destDir>/handoffs/<id>/`. All-or-nothing: returns an error, copying nothing, if any name is refused; otherwise the copied paths relative to `destDir`. */
export function copyHandoffFiles(srcDir: string, destDir: string, handoffId: string, names: string[]): { paths: string[] } | { error: string } {
  for (const n of names) {
    const why = refusal(srcDir, n);
    if (why) return { error: why };
  }
  const paths: string[] = [];
  for (const n of names) {
    const rel = join("handoffs", handoffId, relative(srcDir, resolveInside(srcDir, n)!));
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(realpathSync(join(srcDir, n)), dest);
    paths.push(rel.split("\\").join("/"));
  }
  return { paths };
}
