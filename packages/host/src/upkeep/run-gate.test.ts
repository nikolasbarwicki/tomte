import { expect, test } from "bun:test";

import { createRunGate } from "./run-gate.ts";

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

test("a closed gate reports the count of running work as it changes, and an open one is silent", async () => {
  let active = 2;
  const gate = createRunGate({ active: () => active, pollMs: 5 });
  const heard: number[] = [];
  gate.onChange((n) => heard.push(n));

  expect(gate.closed()).toBe(false);
  expect(gate.active()).toBe(2);
  await Bun.sleep(30);
  expect(heard).toEqual([]);

  gate.close();
  expect(gate.closed()).toBe(true);
  await until(() => heard.length === 1);
  active = 1;
  await until(() => heard.length === 2);
  active = 0;
  await until(() => heard.length === 3);
  expect(heard).toEqual([2, 1, 0]);

  // An unchanged count is not repeated.
  await Bun.sleep(30);
  expect(heard).toHaveLength(3);
  gate.open();
  active = 5;
  await Bun.sleep(30);
  expect(heard).toHaveLength(3);
});

test("opening runs the callback once, closing twice or opening twice changes nothing, and a stopped listener hears nothing", async () => {
  let opened = 0;
  let active = 1;
  const gate = createRunGate({ active: () => active, pollMs: 5, opened: () => void opened++ });
  const heard: number[] = [];
  const stop = gate.onChange((n) => heard.push(n));

  gate.open();
  expect(opened).toBe(0);
  gate.close();
  gate.close();
  await until(() => heard.length === 1);
  stop();
  active = 0;
  await Bun.sleep(30);
  expect(heard).toEqual([1]);

  gate.open();
  gate.open();
  expect(opened).toBe(1);
  expect(gate.closed()).toBe(false);
});
