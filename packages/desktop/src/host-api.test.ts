import { describe, expect, test } from "bun:test";

import { ConnectionError } from "./connection-error.ts";
import { createHostClient, shellCompat, type HostFetch } from "./host-api.ts";

const ORIGIN = "https://host.example.com";
const INFO = {
  version: "1.2.3",
  shellApi: { min: 1, max: 1 },
  mode: "remote",
  capabilities: { reveal: false, headedBrowser: false, browserSandbox: true },
};

interface Call {
  url: string;
  init: RequestInit;
}

function clientAnswering(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchHost: HostFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift() ?? new Error("unexpected request");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { client: createHostClient(fetchHost), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refusal = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "no error",
    (error: unknown) => {
      expect(error).toBeInstanceOf(ConnectionError);
      return (error as Error).message;
    },
  );

describe("checkHost", () => {
  test("returns the host info of a host on the supported API version", async () => {
    const { client, calls } = clientAnswering(json(INFO));
    expect((await client.checkHost(ORIGIN)).mode).toBe("remote");
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/host-info`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("an older host without shellApi, whatever its apiVersion, is read as shell API 1 and is compatible", async () => {
    const { shellApi: _, ...older } = INFO;
    const { client } = clientAnswering(json({ ...older, apiVersion: 7 }));
    const info = await client.checkHost(ORIGIN);
    expect(info.shellApi).toEqual({ min: 1, max: 1 });
    expect(shellCompat(info)).toBe("ok");
  });

  test("a range that does not overlap is returned for shellCompat to judge, not refused", async () => {
    const { client } = clientAnswering(json({ ...INFO, shellApi: { min: 2, max: 3 } }));
    expect(shellCompat(await client.checkHost(ORIGIN))).toBe("update-app");
  });

  test("rejects a server that is not a Tomte host", async () => {
    for (const answer of [
      json({ hello: 1 }),
      new Response("<html>", { status: 200 }),
      json({}, 404),
    ]) {
      const { client } = clientAnswering(answer);
      expect(await refusal(client.checkHost(ORIGIN))).toContain("is not a Tomte host");
    }
  });

  test("names a certificate failure", async () => {
    const { client } = clientAnswering(new TypeError("net::ERR_CERT_AUTHORITY_INVALID"));
    const message = await refusal(client.checkHost(ORIGIN));
    expect(message).toContain("valid certificate");
    expect(message).toContain("net::ERR_CERT_AUTHORITY_INVALID");
  });

  test("names an unreachable host and a timeout", async () => {
    const down = clientAnswering(new TypeError("net::ERR_CONNECTION_REFUSED"));
    expect(await refusal(down.client.checkHost(ORIGIN))).toBe(
      `Could not reach the host at ${ORIGIN}: net::ERR_CONNECTION_REFUSED`,
    );
    const slow = clientAnswering(new DOMException("timed out", "TimeoutError"));
    expect(await refusal(slow.client.checkHost(ORIGIN))).toContain("did not answer");
  });
});

describe("pair", () => {
  test("posts the code and device name as JSON with the profile's origin, without cookies or redirects", async () => {
    const { client, calls } = clientAnswering(json({ deviceId: "d1", token: "t1" }));
    expect(await client.pair(ORIGIN, "ABCD-EFGH-IJKL", "mac (desktop)")).toEqual({
      deviceId: "d1",
      token: "t1",
    });
    const { url, init } = calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/pair`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ origin: ORIGIN, "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      code: "ABCD-EFGH-IJKL",
      name: "mac (desktop)",
    });
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  test("shows the host's own error for a wrong code", async () => {
    const { client } = clientAnswering(json({ error: "invalid pairing code" }, 401));
    expect(await refusal(client.pair(ORIGIN, "x", "mac"))).toBe(
      "The host refused the pairing: invalid pairing code",
    );
  });

  test("rejects an answer that is not a pairing response", async () => {
    const { client } = clientAnswering(json({ ok: true }));
    expect(await refusal(client.pair(ORIGIN, "x", "mac"))).toContain("unknown form");
  });
});

describe("revoke", () => {
  test("sends the device id with the device's bearer token", async () => {
    const { client, calls } = clientAnswering(json({ ok: true }));
    expect(await client.revoke(ORIGIN, "tok", "d1")).toBe("revoked");
    const { url, init } = calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/devices/revoke`);
    expect(init.headers).toEqual({
      origin: ORIGIN,
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
    expect(JSON.parse(init.body as string)).toEqual({ id: "d1" });
  });

  test("treats 401 as already revoked and any other failure as an error", async () => {
    const gone = clientAnswering(json({ error: "pair this device first" }, 401));
    expect(await gone.client.revoke(ORIGIN, "tok", "d1")).toBe("already-revoked");
    const broken = clientAnswering(json({ error: "boom" }, 500));
    expect(await refusal(broken.client.revoke(ORIGIN, "tok", "d1"))).toContain("boom");
    const down = clientAnswering(new TypeError("net::ERR_CONNECTION_REFUSED"));
    expect(await refusal(down.client.revoke(ORIGIN, "tok", "d1"))).toContain("Could not reach");
  });
});

describe("shellCompat", () => {
  const at = (min: number, max: number) =>
    shellCompat({ ...INFO, mode: "remote", shellApi: { min, max } });

  test("any overlap with this app's range is ok, however wide the host's", () => {
    expect(at(1, 1)).toBe("ok");
    expect(at(0, 5)).toBe("ok");
    expect(at(1, 4)).toBe("ok");
    expect(at(0, 1)).toBe("ok");
  });

  test("a host whose newest version is below the app's oldest needs the host updated", () => {
    expect(at(0, 0)).toBe("update-host");
  });

  test("a host whose oldest version is above the app's newest needs the app updated", () => {
    expect(at(2, 2)).toBe("update-app");
    expect(at(2, 9)).toBe("update-app");
  });
});
