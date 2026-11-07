import { describe, expect, test } from "bun:test";

import { ConnectionError } from "./connection-error.ts";
import { parseProfileUrl } from "./profile-url.ts";

describe("parseProfileUrl", () => {
  test("reduces an https URL to its origin", () => {
    expect(parseProfileUrl("  https://Claudebot.Example.com/  ")).toBe(
      "https://claudebot.example.com",
    );
    expect(parseProfileUrl("https://host.example.com:8443")).toBe("https://host.example.com:8443");
  });

  test("allows plain http for loopback hosts only", () => {
    for (const url of ["http://127.0.0.1:4000", "http://localhost:4000/", "http://[::1]:4000"])
      expect(parseProfileUrl(url)).toBe(new URL(url).origin);
    for (const url of [
      "http://host.example.com",
      "http://100.64.0.1:4000",
      "http://192.168.1.5",
      "http://127.0.0.1.example.com",
    ])
      expect(() => parseProfileUrl(url)).toThrow(/Plain http/);
  });

  test("refuses credentials, paths, queries and fragments", () => {
    for (const url of [
      "https://user:pw@host.example.com",
      "https://user@host.example.com",
      "https://host.example.com/app",
      "https://host.example.com/?a=1",
      "https://host.example.com?",
      "https://host.example.com/#x",
    ])
      expect(() => parseProfileUrl(url)).toThrow(ConnectionError);
  });

  test("refuses other schemes and text that is not a URL", () => {
    for (const url of ["ftp://host.example.com", "file:///etc/hosts", "javascript:1", "nope", ""])
      expect(() => parseProfileUrl(url)).toThrow(ConnectionError);
  });
});
