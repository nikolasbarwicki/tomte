import { describe, expect, test } from "bun:test";

import { connectionItems } from "./connection-items.ts";

const profiles = [
  { id: "local", name: "This computer", origin: "http://127.0.0.1:1", active: false },
  { id: "p1", name: "Work", origin: "https://work.example.com", active: true },
];

describe("connection menu items", () => {
  test("one radio per profile with the active one checked, then Manage Connections…", () => {
    const items = connectionItems(profiles, { connect: () => {}, manage: () => {} });
    expect(items.map((i) => [i.label, i.type, i.checked])).toEqual([
      ["This computer", "radio", false],
      ["Work", "radio", true],
      [undefined, "separator", undefined],
      ["Manage Connections…", undefined, undefined],
    ]);
  });

  test("a radio connects its own profile and Manage opens the manager", () => {
    const calls: string[] = [];
    const items = connectionItems(profiles, {
      connect: (id) => void calls.push(`connect ${id}`),
      manage: () => void calls.push("manage"),
    });
    for (const item of items) item.click?.({} as never, undefined, {} as never);
    expect(calls).toEqual(["connect local", "connect p1", "manage"]);
  });
});
