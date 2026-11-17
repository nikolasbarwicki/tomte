import { afterEach, describe, expect, test } from "bun:test";

import { DeviceList, PairingCodeResponse, PairingResponse } from "@tomte/contract/api";

import { asDevice, clientPost, pairDevice } from "../testing/paired-device.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const hosts: HandoffHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

const start = async () => {
  const host = await startHandoffHost();
  hosts.push(host);
  return host;
};

const listDevices = async (host: HandoffHost, token = host.deviceToken) => {
  const res = await clientPost(host.server, token, "/api/devices/list", {});
  expect(res.status).toBe(200);
  return DeviceList.parse(await res.json());
};

const revoke = (host: HandoffHost, token: string, id: string) =>
  clientPost(host.server, token, "/api/devices/revoke", { id });

/** An open event stream as a paired device's page holds it; `closed` settles when the host ends it. */
async function openEventStream(host: HandoffHost, token: string) {
  const res = await fetch(`${host.clientUrl}/api/events`, { headers: asDevice(token) });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read();
  const closed = (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {}
    return true;
  })();
  const stillOpen = () =>
    Promise.race([closed, Bun.sleep(300).then(() => false)]).then((done) => !done);
  return { closed, stillOpen };
}

describe("listing devices", () => {
  test("shows each paired device with its name, pairing time and last activity", async () => {
    const host = await start();
    const [self] = await listDevices(host);
    expect(self).toMatchObject({ name: "test device", current: true });
    const t0 = self!.createdAt;
    expect(self!.lastSeenAt).toBe(t0);

    host.advanceClock(5 * 60_000);
    const phone = pairDevice(host.server, "phone");
    const [, neverActive] = await listDevices(host);
    expect(neverActive).toMatchObject({
      name: "phone",
      current: false,
      createdAt: t0 + 5 * 60_000,
      lastSeenAt: null,
    });

    host.advanceClock(30_000);
    const asPhone = await listDevices(host, phone);
    expect(asPhone.map((d) => [d.name, d.current, d.lastSeenAt])).toEqual([
      ["test device", false, t0 + 5 * 60_000],
      ["phone", true, t0 + 5 * 60_000 + 30_000],
    ]);
  });

  test("a busy device's last activity moves forward only once a minute", async () => {
    const host = await start();
    const [first] = await listDevices(host);
    host.advanceClock(59_000);
    expect((await listDevices(host))[0]!.lastSeenAt).toBe(first!.lastSeenAt!);
    host.advanceClock(1_000);
    await listDevices(host);
    expect((await listDevices(host))[0]!.lastSeenAt).toBe(first!.lastSeenAt! + 60_000);
  });

  test("never shows a token or digest", async () => {
    const host = await start();
    const res = await clientPost(host.server, host.deviceToken, "/api/devices/list", {});
    const text = await res.text();
    expect(text).not.toContain(host.deviceToken);
    expect(Object.keys(JSON.parse(text)[0]).sort()).toEqual([
      "createdAt",
      "current",
      "id",
      "lastSeenAt",
      "name",
    ]);
  });

  test("the device routes need a device token like every other API route", async () => {
    const host = await start();
    const post = (path: string) =>
      fetch(`${host.clientUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: host.clientUrl },
        body: "{}",
      });
    for (const path of ["/api/devices/list", "/api/devices/revoke", "/api/devices/pairing-code"])
      expect((await post(path)).status).toBe(401);
  });
});

describe("revoking a device", () => {
  test("its next request gets 401 and its open event stream closes", async () => {
    const host = await start();
    const phone = pairDevice(host.server, "phone");
    const stream = await openEventStream(host, phone);
    expect(await stream.stillOpen()).toBe(true);

    const id = (await listDevices(host)).find((d) => d.name === "phone")!.id;
    expect((await revoke(host, host.deviceToken, id)).status).toBe(200);

    expect(await stream.closed).toBe(true);
    const next = await fetch(`${host.clientUrl}/api/info`, { headers: asDevice(phone) });
    expect(next.status).toBe(401);
    expect((await listDevices(host)).map((d) => d.name)).toEqual(["test device"]);
  });

  test("leaves every other device's event stream and access alone", async () => {
    const host = await start();
    const phone = pairDevice(host.server, "phone");
    const laptop = await openEventStream(host, host.deviceToken);
    const id = (await listDevices(host)).find((d) => d.name === "phone")!.id;
    await revoke(host, host.deviceToken, id);
    expect(await laptop.stillOpen()).toBe(true);
    expect((await fetch(`${host.clientUrl}/api/info`, { headers: host.authHeaders })).status).toBe(
      200,
    );
    expect((await fetch(`${host.clientUrl}/api/info`, { headers: asDevice(phone) })).status).toBe(
      401,
    );
  });

  test("closes every stream the device has open", async () => {
    const host = await start();
    const phone = pairDevice(host.server, "phone");
    const streams = await Promise.all([openEventStream(host, phone), openEventStream(host, phone)]);
    const id = (await listDevices(host)).find((d) => d.name === "phone")!.id;
    await revoke(host, host.deviceToken, id);
    expect(await Promise.all(streams.map((s) => s.closed))).toEqual([true, true]);
  });

  test("a device can revoke itself and still gets the answer", async () => {
    const host = await start();
    const [self] = await listDevices(host);
    const stream = await openEventStream(host, host.deviceToken);
    const res = await revoke(host, host.deviceToken, self!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await stream.closed).toBe(true);
    expect((await fetch(`${host.clientUrl}/api/info`, { headers: host.authHeaders })).status).toBe(
      401,
    );
  });

  test("an unknown device is a 404 and a missing id is a 400", async () => {
    const host = await start();
    expect((await revoke(host, host.deviceToken, "no-such-device")).status).toBe(404);
    const res = await clientPost(host.server, host.deviceToken, "/api/devices/revoke", {});
    expect(res.status).toBe(400);
    expect((await listDevices(host)).length).toBe(1);
  });
});

describe("creating a pairing code", () => {
  test("a code from the route pairs a second device", async () => {
    const host = await start();
    const created = await clientPost(
      host.server,
      host.deviceToken,
      "/api/devices/pairing-code",
      {},
    );
    expect(created.status).toBe(200);
    const { code } = PairingCodeResponse.parse(await created.json());
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    const exchanged = await fetch(`${host.clientUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host.clientUrl },
      body: JSON.stringify({ code, name: "tablet" }),
    });
    expect(exchanged.status).toBe(200);
    const { token } = PairingResponse.parse(await exchanged.json());

    const devices = await listDevices(host, token);
    expect(devices.map((d) => d.name)).toEqual(["test device", "tablet"]);
    expect(devices.find((d) => d.current)?.name).toBe("tablet");
  });

  test("works from a browser's session cookie as well", async () => {
    const host = await start();
    const res = await fetch(`${host.clientUrl}/api/devices/pairing-code`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: host.clientUrl,
        cookie: `tomte_session=${host.deviceToken}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});
