import { createHash } from "node:crypto";

import { ToolError } from "./tools/result.ts";

/** The 6th identical call in a row with the page unchanged is refused. */
const LOOP_LIMIT = 6;

/** The engine writes refs as `[ref=e5]` or among other attributes, as in `[expanded=false, ref=e2]`. */
const REF_IN_TEXT = /\bref=([A-Za-z0-9_]+)(?=[,\]])/g;
const REF_ARG = /^r(\d+)\.([A-Za-z0-9_]+)$/;

/** What the bot has been shown of one bot's page: the snapshot revision and the repeated-call streak. Lives as long as the host. */
export class PageState {
  private revision = 0;
  private last?: { key: string; hash: string; streak: number };

  /** Numbers a new snapshot and rewrites its engine refs (`ref=e5`) as `ref=r7.e5`. */
  numberSnapshot(snapshot: string): string {
    const revision = ++this.revision;
    return snapshot.replace(REF_IN_TEXT, (_, ref) => `ref=r${revision}.${ref}`);
  }

  /** The page changed without a snapshot reaching the bot (a sign-in): refs it holds are stale from now on. */
  invalidate() {
    this.revision++;
  }

  /** The engine's `@ref` for a ref from the latest snapshot; any other ref is stale. */
  engineRef(ref: string): string {
    const m = REF_ARG.exec(ref);
    if (!m || Number(m[1]) !== this.revision) throw new ToolError("stale ref, take a new snapshot");
    return `@${m[2]}`;
  }

  /** Throws when `key` would be the 6th identical call in a row with an unchanged page. */
  checkLoop(key: string) {
    if (this.last?.key === key && this.last.streak >= LOOP_LIMIT - 1) {
      throw new ToolError(
        `this exact call has been made ${this.last.streak} times in a row and the page has not changed; try something different, or report that you are stuck`,
      );
    }
  }

  /** `outcome` is what the call returned; a repeat that returns the same outcome extends the streak. */
  record(key: string, outcome: string) {
    const hash = createHash("sha1").update(outcome).digest("hex");
    const same = this.last?.key === key && this.last.hash === hash;
    this.last = { key, hash, streak: same ? this.last!.streak + 1 : 1 };
  }
}
