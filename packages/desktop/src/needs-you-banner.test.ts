import { beforeEach, describe, expect, test } from "bun:test";

import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import { createNeedsYouBanner, type Note, type NeedsYouBanner } from "./needs-you-banner.ts";

const MAC = { id: "local", name: "This computer" };
const VPS = { id: "p1", name: "my-vps" };

const bot = (id: string, needsYou: number, at = 0, sources: string[] = []): BotSummary =>
  ({
    id,
    name: id.toUpperCase(),
    needsYou,
    needsYouAt: at,
    needsYouSources: sources,
  }) as BotSummary;
const status = (signedOut: boolean): HostStatus => ({
  version: "0.1.0",
  mode: "remote",
  claude: { state: signedOut ? "signed-out" : "signed-in", ignoredEnv: [], checkedAt: 1 },
  update: { status: "unmanaged", reason: "x" },
  autoUpdate: false,
  problems: signedOut ? [{ kind: "claude-signed-out" }] : [],
});

let visible: boolean;
let notes: { note: Note; closed: boolean }[];
let opened: string[];
let banner: NeedsYouBanner;
beforeEach(() => {
  visible = false;
  notes = [];
  opened = [];
  banner = createNeedsYouBanner({
    visible: () => visible,
    show(note) {
      const record = { note, closed: false };
      notes.push(record);
      return { close: () => void (record.closed = true) };
    },
    reveal: () => void opened.push("reveal"),
    open: (hostId, botId) => void opened.push(`${hostId} ${botId ?? "-"}`),
  });
});
const live = () => notes.filter((n) => !n.closed);

describe("the needs-you banner over several hosts", () => {
  test("the first slice of a host is a baseline; a rise on any host shows a banner that names the host", () => {
    banner.bots(MAC, [bot("a", 2)]);
    banner.bots(VPS, [bot("b", 0)]);
    expect(notes).toEqual([]);
    banner.bots(VPS, [bot("b", 1, 5, ["Sentry"])]);
    expect(live().map((n) => [n.note.title, n.note.body])).toEqual([
      ["B (my-vps): 1 thing needs you", "Sentry"],
    ]);
  });

  test("a later rise replaces the banner; a fall or the same count shows none", () => {
    banner.bots(MAC, [bot("a", 0)]);
    banner.bots(VPS, [bot("b", 0)]);
    banner.bots(MAC, [bot("a", 1, 1)]);
    banner.bots(VPS, [bot("b", 2, 2)]);
    expect(notes.map((n) => n.closed)).toEqual([true, false]);
    expect(live()[0]!.note.title).toBe("B (my-vps): 2 things need you");
    banner.bots(VPS, [bot("b", 2, 3)]);
    banner.bots(VPS, [bot("b", 1, 3)]);
    expect(notes).toHaveLength(2);
  });

  test("a rise while the window is visible shows none, and showing the window closes the banner", () => {
    banner.bots(MAC, [bot("a", 0)]);
    visible = true;
    banner.bots(MAC, [bot("a", 1)]);
    expect(notes).toEqual([]);
    visible = false;
    banner.bots(MAC, [bot("a", 2)]);
    expect(live()).toHaveLength(1);
    banner.windowShown();
    expect(live()).toEqual([]);
  });

  test("a click reveals the window and opens the host on the bot with the newest item at that moment", () => {
    banner.bots(VPS, [bot("old", 1, 1), bot("new", 0)]);
    banner.bots(VPS, [bot("old", 1, 1), bot("new", 1, 9)]);
    banner.bots(VPS, [bot("old", 1, 1), bot("later", 1, 20), bot("new", 1, 9)]);
    live()[0]!.note.onClick();
    expect(opened).toEqual(["reveal", "p1 later"]);
  });

  test("a stream that opens again starts from a new baseline and closes that host's banner only", () => {
    banner.bots(MAC, [bot("a", 0)]);
    banner.bots(VPS, [bot("b", 0)]);
    banner.bots(MAC, [bot("a", 1)]);
    banner.reset("p1");
    expect(live()).toHaveLength(1);
    banner.bots(VPS, [bot("b", 3)]);
    expect(live()).toHaveLength(1);
    banner.reset("local");
    expect(live()).toEqual([]);
    banner.bots(MAC, [bot("a", 5)]);
    expect(notes).toHaveLength(1);
  });

  test("a new problem of a host shows a banner naming the host and the problem; a click opens the host alone", () => {
    banner.status(VPS, status(false));
    banner.bots(VPS, [bot("b", 4, 1)]);
    banner.status(VPS, status(true));
    expect(live().map((n) => [n.note.title, n.note.body])).toEqual([
      ["my-vps: Claude signed out", "Open Tomte to fix it."],
    ]);
    live()[0]!.note.onClick();
    expect(opened).toEqual(["reveal", "p1 -"]);
    banner.status(VPS, status(true));
    banner.status(VPS, status(false));
    expect(notes).toHaveLength(1);
  });

  test("the first status of a host is a baseline even when it holds a problem", () => {
    banner.status(VPS, status(true));
    banner.bots(VPS, [bot("b", 0)]);
    expect(notes).toHaveLength(0);
  });

  test("a long source list is cut", () => {
    banner.bots(MAC, [bot("a", 0)]);
    banner.bots(MAC, [bot("a", 1, 1, ["x".repeat(300)])]);
    expect(live()[0]!.note.body).toHaveLength(200);
    expect(live()[0]!.note.body.endsWith("…")).toBe(true);
  });
});

describe("a rise elsewhere", () => {
  test("is not hidden by another host's open items", () => {
    banner.bots(MAC, [bot("a", 5, 1)]);
    banner.bots(VPS, [bot("b", 0)]);
    banner.bots(VPS, [bot("b", 1, 2)]);
    expect(live()[0]!.note.title).toBe("B (my-vps): 1 thing needs you");
  });
});
