import { describe, expect, test } from "bun:test";

import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import type { FollowTarget } from "./connections.ts";
import { createFollowedHosts, type StartFollowing } from "./follow-hosts.ts";

type Handlers = Parameters<StartFollowing>[1];
const MAC: FollowTarget = {
  id: "local",
  name: "This computer",
  origin: "http://127.0.0.1:1",
  token: "t1",
};
const VPS: FollowTarget = {
  id: "p1",
  name: "my-vps",
  origin: "https://vps.example.com",
  token: "t2",
};
const BOTS = [{ id: "a" }] as BotSummary[];
const STATUS = { version: "1" } as HostStatus;

function setup() {
  const streams: { target: FollowTarget; on: Handlers; stopped: boolean }[] = [];
  const calls: string[] = [];
  const hosts = createFollowedHosts({
    start(target, on) {
      const stream = { target, on, stopped: false };
      streams.push(stream);
      calls.push(`start ${target.id}`);
      return { stop: () => void (stream.stopped = true) };
    },
    banner: {
      bots: (host, bots) => void calls.push(`bots ${host.id} ${bots.length}`),
      status: (host) => void calls.push(`status ${host.id}`),
      reset: (id) => void calls.push(`reset ${id}`),
    },
    changed: () => void calls.push("changed"),
    log: (message) => void calls.push(`log ${message}`),
  });
  return { hosts, streams, calls };
}

describe("following hosts", () => {
  test("opens one stream per target and keeps each host's own view", () => {
    const { hosts, streams } = setup();
    hosts.sync([MAC, VPS]);
    expect(streams.map((s) => s.target.id)).toEqual(["local", "p1"]);
    expect(hosts.view("p1")).toEqual({ name: "my-vps", connection: "connecting" });
    streams[1]!.on.onOpen();
    streams[1]!.on.onBots(BOTS);
    streams[1]!.on.onStatus(STATUS);
    expect(hosts.view("p1")).toEqual({
      name: "my-vps",
      connection: "open",
      bots: BOTS,
      status: STATUS,
    });
    expect(hosts.view("local")?.connection).toBe("connecting");
  });

  test("sync again with the same targets opens nothing; a new token restarts only that host", () => {
    const { hosts, streams } = setup();
    hosts.sync([MAC, VPS]);
    hosts.sync([MAC, VPS]);
    expect(streams).toHaveLength(2);
    hosts.sync([{ ...MAC, token: "t3" }, VPS]);
    expect(streams.map((s) => [s.target.id, s.stopped])).toEqual([
      ["local", true],
      ["p1", false],
      ["local", false],
    ]);
  });

  test("a host that is no longer listed loses its stream and its view, and the banner forgets it", () => {
    const { hosts, streams, calls } = setup();
    hosts.sync([MAC, VPS]);
    streams[1]!.on.onBots(BOTS);
    hosts.sync([MAC]);
    expect(streams[1]!.stopped).toBe(true);
    expect(hosts.view("p1")).toBeUndefined();
    expect(calls).toContain("reset p1");
    const before = calls.length;
    streams[1]!.on.onBots(BOTS);
    streams[1]!.on.onDown("late");
    expect(calls).toHaveLength(before);
  });

  test("an open stream resets the banner and clears stale data; a down one clears the view and logs once", () => {
    const { hosts, streams, calls } = setup();
    hosts.sync([VPS]);
    streams[0]!.on.onOpen();
    streams[0]!.on.onBots(BOTS);
    streams[0]!.on.onStatus(STATUS);
    expect(calls.slice(calls.indexOf("start p1"))).toContain("bots p1 1");
    streams[0]!.on.onDown("the stream ended");
    expect(hosts.view("p1")).toEqual({ name: "my-vps", connection: "down" });
    expect(calls.filter((c) => c.startsWith("log "))).toEqual([
      "log event stream of https://vps.example.com (my-vps) is down: the stream ended",
    ]);
    streams[0]!.on.onOpen();
    expect(calls.filter((c) => c === "reset p1")).toHaveLength(2);
    expect(hosts.view("p1")).toMatchObject({ connection: "open", bots: undefined });
  });

  test("stop ends every stream", () => {
    const { hosts, streams } = setup();
    hosts.sync([MAC, VPS]);
    hosts.stop();
    expect(streams.every((s) => s.stopped)).toBe(true);
    expect(hosts.view("local")).toBeUndefined();
  });
});
