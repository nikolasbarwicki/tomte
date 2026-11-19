import { expect, test } from "bun:test";
import { hostname } from "node:os";

import type { HostStatus } from "@tomte/contract/host-status";

import type { Notice } from "../channels/index.ts";
import { createHostAlerts, hostNameOf } from "./host-alerts.ts";

test("a host is known by its public address, or by the machine's name when that address is the loopback one", () => {
  expect(hostNameOf("https://tomte.example.com")).toBe("tomte.example.com");
  expect(hostNameOf("http://127.0.0.1:4000")).toBe(hostname());
  expect(hostNameOf("http://localhost:4000")).toBe(hostname());
  expect(hostNameOf("not a url")).toBe(hostname());
});

test("a failed update is told once while it lasts, and again if it clears and returns", () => {
  const notices: Notice[] = [];
  const alerts = createHostAlerts({ hostName: "my-vps", notify: (n) => void notices.push(n) });
  const failed = { kind: "update-failed", version: "0.4.2", rolledBackTo: "0.4.1" } as const;
  const status = (problems: HostStatus["problems"]) => ({ problems }) as HostStatus;

  alerts.sync(status([]));
  alerts.sync(status([failed]));
  alerts.sync(status([failed]));
  expect(notices).toEqual([{ kind: "host_problem", hostName: "my-vps", problem: failed }]);

  alerts.sync(status([]));
  alerts.sync(status([failed]));
  expect(notices).toHaveLength(2);
});
