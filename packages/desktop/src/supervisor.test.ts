import { describe, expect, test } from "bun:test";

import type { Sidecar } from "./sidecar.ts";
import { createSupervisor, type HostState } from "./supervisor.ts";

/** A sidecar whose end the test controls. */
function fakeSidecar(): Sidecar & { crash(): void; stopped: boolean } {
  const exited = Promise.withResolvers<void>();
  const sidecar = {
    clientUrl: "http://127.0.0.1:1/",
    token: "t",
    exited: exited.promise,
    stopped: false,
    crash: () => exited.resolve(),
    async stop() {
      sidecar.stopped = true;
      exited.resolve();
      await exited.promise;
    },
  };
  return sidecar;
}

const tick = () => Bun.sleep(5);

function setup(launch: () => Promise<Sidecar>) {
  const supervisor = createSupervisor(launch);
  const seen: HostState["status"][] = [];
  supervisor.onChange((s) => void seen.push(s.status));
  return { supervisor, seen };
}

describe("the host supervisor", () => {
  test("goes from starting to running with the sidecar that was launched", async () => {
    const sidecar = fakeSidecar();
    const { supervisor, seen } = setup(async () => sidecar);
    await supervisor.start();
    expect(seen).toEqual(["starting", "running"]);
    expect(supervisor.state()).toEqual({ status: "running", sidecar });
  });

  test("an unexpected exit is reported as stopped, and start() brings it back with a fresh sidecar", async () => {
    const launched: ReturnType<typeof fakeSidecar>[] = [];
    const { supervisor, seen } = setup(async () => {
      launched.push(fakeSidecar());
      return launched.at(-1)!;
    });
    await supervisor.start();
    launched[0]!.crash();
    await tick();
    expect(supervisor.state().status).toBe("stopped");

    await supervisor.start();
    expect(supervisor.state()).toEqual({ status: "running", sidecar: launched[1]! });
    expect(seen).toEqual(["starting", "running", "stopped", "starting", "running"]);
    launched[0]!.crash();
    await tick();
    expect(supervisor.state().status).toBe("running");
  });

  test("start() while starting or running launches nothing more", async () => {
    let launches = 0;
    const gate = Promise.withResolvers<void>();
    const { supervisor } = setup(async () => {
      launches++;
      await gate.promise;
      return fakeSidecar();
    });
    const first = supervisor.start();
    const second = supervisor.start();
    gate.resolve();
    await Promise.all([first, second]);
    await supervisor.start();
    expect(launches).toBe(1);
  });

  test("a launch that fails leaves the host stopped with the reason, and can be tried again", async () => {
    let attempt = 0;
    const { supervisor } = setup(async () => {
      if (attempt++ === 0) throw new Error("no host binary");
      return fakeSidecar();
    });
    await supervisor.start();
    expect(supervisor.state()).toEqual({ status: "stopped", reason: "no host binary" });
    await supervisor.start();
    expect(supervisor.state().status).toBe("running");
  });

  test("stop() ends the sidecar without a stopped state, and nothing starts after it", async () => {
    const sidecar = fakeSidecar();
    const { supervisor, seen } = setup(async () => sidecar);
    await supervisor.start();
    await supervisor.stop();
    await tick();
    expect(sidecar.stopped).toBe(true);
    expect(seen).toEqual(["starting", "running"]);
    await supervisor.start();
    expect(seen).toEqual(["starting", "running"]);
  });

  test("stop() during a start waits for the sidecar and then stops it", async () => {
    const sidecar = fakeSidecar();
    const gate = Promise.withResolvers<void>();
    const { supervisor } = setup(async () => {
      await gate.promise;
      return sidecar;
    });
    const starting = supervisor.start();
    const stopping = supervisor.stop();
    gate.resolve();
    await Promise.all([starting, stopping]);
    expect(sidecar.stopped).toBe(true);
  });

  test("a listener can be removed", async () => {
    const supervisor = createSupervisor(async () => fakeSidecar());
    const seen: string[] = [];
    const remove = supervisor.onChange((s) => void seen.push(s.status));
    remove();
    await supervisor.start();
    expect(seen).toEqual([]);
  });
});
