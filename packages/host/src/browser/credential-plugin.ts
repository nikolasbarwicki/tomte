#!/usr/bin/env bun
// claudebot's credential plugin for the browser engine (`agent-browser.plugin.v1`, `credential.resolve`).
// The engine daemon spawns it; argv[2] is the host's loopback exchange URL, and the request's `itemRef` is a
// one-time nonce. It prints only the protocol envelope on stdout and never logs.
const PROTOCOL = "agent-browser.plugin.v1";

const reply = (body: object) =>
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ...body }));

const input = JSON.parse(await Bun.stdin.text());
if (input.protocol !== PROTOCOL) {
  reply({ success: false, error: "unsupported protocol" });
} else if (input.type === "plugin.manifest") {
  reply({ success: true, manifest: { name: "claudebot", capabilities: ["credential.read"] } });
} else if (input.type === "credential.resolve") {
  try {
    const res = await fetch(process.argv[2], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: input.request?.itemRef, url: input.request?.url }),
    });
    const credential = res.ok ? await res.json() : undefined;
    reply(credential ? { success: true, credential } : { success: false, error: "denied" });
  } catch {
    reply({ success: false, error: "host unreachable" });
  }
} else {
  reply({ success: false, error: "unsupported request" });
}
