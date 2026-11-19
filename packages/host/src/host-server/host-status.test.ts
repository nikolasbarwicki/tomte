import { expect, test } from "bun:test";

import { HostStatusEvent } from "@tomte/contract/host-status";

import type { ClaudeAccess } from "../harness/index.ts";
import { parseHostConfig } from "../platform/config.ts";
import type { Upkeep } from "../upkeep/index.ts";
import { createHostStatus } from "./host-status.ts";

const claude = {
  status: () => ({ state: "signed-out", ignoredEnv: [], checkedAt: 5 }),
} as Pick<ClaudeAccess, "status"> as ClaudeAccess;

const configOf = (...flags: string[]) =>
  parseHostConfig(["--data-root", "/data", ...flags], {}, { platform: "linux", home: "/home" })
    .config;

let failed = false;
let auto = false;
let offer: ReturnType<Upkeep["rollbackOffer"]>;
const upkeep = {
  status: () =>
    failed
      ? { status: "failed", version: "0.2.0", reason: "x", rolledBackTo: "0.1.0" }
      : { status: "unmanaged", reason: "no helper" },
  autoUpdate: () => auto,
  rollbackOffer: () => offer,
} as Pick<Upkeep, "status" | "autoUpdate" | "rollbackOffer"> as Upkeep;

test("the status is the sign-in and the update status as their owners report them", () => {
  const status = createHostStatus({
    config: configOf("--mode", "remote", "--secrets-key-file", "/k"),
    claude,
    upkeep,
  }).current();
  expect(status.mode).toBe("remote");
  expect(status.claude.state).toBe("signed-out");
  expect(status.update).toEqual({ status: "unmanaged", reason: "no helper" });
});

test("the event is the status as the stream carries it, and parses as one", () => {
  const status = createHostStatus({ config: configOf(), claude, upkeep });
  const event = HostStatusEvent.parse(status.event());
  expect(event.status).toEqual(status.current());
  expect(event.status.claude.state).toBe("signed-out");
});

test("a signed-out host reports the problem, a signed-in one none", () => {
  const withState = (state: "signed-in" | "signed-out") =>
    createHostStatus({
      config: configOf(),
      claude: { status: () => ({ state, ignoredEnv: [], checkedAt: 5 }) } as Pick<
        ClaudeAccess,
        "status"
      > as ClaudeAccess,
      upkeep,
    }).current().problems;
  expect(withState("signed-out")).toEqual([{ kind: "claude-signed-out" }]);
  expect(withState("signed-in")).toEqual([]);
});

test("a failed update is a problem beside the sign-in, and the automatic setting is carried", () => {
  failed = true;
  auto = true;
  try {
    const status = createHostStatus({ config: configOf(), claude, upkeep }).current();
    expect(status.autoUpdate).toBe(true);
    expect(status.problems).toEqual([
      { kind: "claude-signed-out" },
      { kind: "update-failed", version: "0.2.0", rolledBackTo: "0.1.0" },
    ]);
  } finally {
    failed = false;
    auto = false;
  }
});

test("a rollback offer is rollbackTo, a restore offer is restoreTo, and neither is reported otherwise", () => {
  const current = () => createHostStatus({ config: configOf(), claude, upkeep }).current();
  try {
    expect(current().rollbackTo).toBeUndefined();
    expect(current().restoreTo).toBeUndefined();
    offer = { kind: "rollback", version: "0.1.0" };
    expect(current()).toMatchObject({ rollbackTo: "0.1.0" });
    expect(current().restoreTo).toBeUndefined();
    offer = { kind: "restore", version: "0.1.0", snapshotAt: 5 };
    expect(current().restoreTo).toEqual({ version: "0.1.0", snapshotAt: 5 });
    expect(current().rollbackTo).toBeUndefined();
  } finally {
    offer = undefined;
  }
});
