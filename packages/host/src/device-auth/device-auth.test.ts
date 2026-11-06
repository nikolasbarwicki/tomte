import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "../platform/db.ts";
import { createDeviceAuth } from "./index.ts";

function setup() {
  let clock = 1_000_000;
  const auth = createDeviceAuth({ db: migrate(new Database(":memory:")), now: () => clock });
  const { token } = auth.pair(auth.createPairingCode(), "laptop")!;
  return { auth, token, advance: (ms: number) => (clock += ms) };
}

describe("a device's last activity", () => {
  test("is recorded on its first request and moves forward only once a minute", () => {
    const { auth, token, advance } = setup();
    expect(auth.list()[0]!.lastSeenAt).toBeNull();

    auth.authenticate(token);
    const first = auth.list()[0]!.lastSeenAt;
    expect(first).toBe(1_000_000);

    advance(59_000);
    auth.authenticate(token);
    expect(auth.list()[0]!.lastSeenAt).toBe(first);

    advance(1_000);
    auth.authenticate(token);
    expect(auth.list()[0]!.lastSeenAt).toBe(1_060_000);
  });

  test("is not recorded for a token that belongs to no device", () => {
    const { auth, advance } = setup();
    advance(120_000);
    expect(auth.authenticate("not-a-token")).toBeUndefined();
    expect(auth.list()[0]!.lastSeenAt).toBeNull();
  });
});
