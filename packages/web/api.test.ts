import { describe, expect, test } from "bun:test";

import { HostEvent, LiveMessage } from "@claudebot/contract/events";
import { z } from "zod";

import { errorOf, InvalidPayload, parseJson, readJson } from "./api.ts";

describe("parseJson", () => {
  test("returns a payload that matches its schema", () => {
    expect(parseJson('{"type":"delta","text":"hi"}', HostEvent, "/api/events")).toEqual({
      type: "delta",
      text: "hi",
    });
  });

  test.each([
    ["an unknown event type", '{"type":"nope"}'],
    ["a field of the wrong type", '{"type":"delta","text":1}'],
    ["text that is not JSON", "data: {"],
  ])("rejects %s with InvalidPayload naming the source", (_, raw) => {
    expect(() => parseJson(raw, HostEvent, "/api/events")).toThrow(InvalidPayload);
    expect(() => parseJson(raw, HostEvent, "/api/events")).toThrow("/api/events");
  });

  test("rejects a live-view frame without its size", () => {
    expect(() => parseJson('{"type":"frame","data":"x"}', LiveMessage, "live")).toThrow(
      InvalidPayload,
    );
  });
});

describe("readJson", () => {
  const Created = z.object({ id: z.string() });

  test("parses a response body", async () => {
    expect(await readJson(Response.json({ id: "a" }), Created)).toEqual({ id: "a" });
  });

  test("rejects a response body that does not match", async () => {
    expect(readJson(Response.json({ id: 1 }), Created)).rejects.toBeInstanceOf(InvalidPayload);
  });
});

describe("errorOf", () => {
  test("reads the host's error", async () => {
    expect(await errorOf(Response.json({ error: "nope" }, { status: 400 }))).toBe("nope");
  });

  test("falls back to the status when the body has no error", async () => {
    expect(await errorOf(new Response("oops", { status: 500 }))).toBe("Request failed (500)");
  });
});
