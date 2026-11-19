import { describe, expect, test } from "bun:test";

import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import type { ProfileView } from "./connections.ts";
import type { HostView } from "./follow-hosts.ts";
import { hostLines, hostLineText } from "./host-lines.ts";
import type { Sidecar } from "./sidecar.ts";
import type { HostState } from "./supervisor.ts";

const running: HostState = { status: "running", sidecar: {} as Sidecar };
const profiles: ProfileView[] = [
  { id: "local", name: "This computer", origin: "http://127.0.0.1:1", active: true },
  { id: "p1", name: "my-vps", origin: "https://vps.example.com", active: false },
];
const bot = (needsYou: number) => ({ needsYou }) as BotSummary;
const status = (problems: HostStatus["problems"]): HostStatus => ({
  version: "0.1.0",
  mode: "remote",
  claude: { state: problems.length > 0 ? "signed-out" : "signed-in", ignoredEnv: [], checkedAt: 1 },
  update: { status: "unmanaged", reason: "no helper" },
  autoUpdate: false,
  problems,
});
const views = (map: Record<string, HostView>) => (id: string) => map[id];

describe("host lines", () => {
  test("a line per host: this computer from the supervisor, a server from its stream, with counts and the first problem", () => {
    const lines = hostLines(
      profiles,
      running,
      views({
        local: { name: "This computer", connection: "open", bots: [bot(1)], status: status([]) },
        p1: {
          name: "my-vps",
          connection: "open",
          bots: [bot(0), bot(2)],
          status: status([{ kind: "claude-signed-out" }]),
        },
      }),
    );
    expect(lines.map(hostLineText)).toEqual([
      "This computer: running · 1 needs you",
      "my-vps: connected · 3 need you · Claude signed out",
    ]);
  });

  test("a host that is not up shows no count and no problem", () => {
    const stale: Omit<HostView, "connection"> = {
      name: "my-vps",
      bots: [bot(4)],
      status: status([{ kind: "claude-signed-out" }]),
    };
    const text = (v: HostView | undefined, local: HostState = running) =>
      hostLines(profiles, local, views(v ? { p1: v } : {})).map(hostLineText);
    expect(text(undefined, { status: "stopped", reason: "exited" })).toEqual([
      "This computer: stopped",
      "my-vps: connecting",
    ]);
    expect(text({ ...stale, connection: "down" })[1]).toBe("my-vps: unreachable");
    expect(text({ ...stale, connection: "connecting" })[1]).toBe("my-vps: connecting");
    expect(text(undefined, { status: "starting" })[0]).toBe("This computer: starting");
  });

  test("a paused host reads paused with no count, even when its last stream still said otherwise", () => {
    const lines = hostLines(
      profiles,
      { status: "paused" },
      views({
        local: { name: "This computer", connection: "open", bots: [bot(3)], status: status([]) },
      }),
    );
    expect(lines.map(hostLineText)).toEqual(["This computer: paused", "my-vps: connecting"]);
    expect(lines[0]!.needsYou).toBe(0);
  });
});

test("a failed update reads in the tray as the update that failed and what was put back", () => {
  expect(
    hostLineText({
      id: "p1",
      name: "my-vps",
      state: "connected",
      needsYou: 1,
      problem: { kind: "update-failed", version: "0.4.2", rolledBackTo: "0.4.1" },
    }),
  ).toBe("my-vps: connected · 1 needs you · Update to 0.4.2 failed, rolled back to 0.4.1");
});
