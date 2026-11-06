#!/usr/bin/env bun
// claudebot's credential plugin for the browser engine (`agent-browser.plugin.v1`, `credential.resolve`).
// The engine daemon spawns it; argv[2] is the host's loopback exchange URL, and the request's `itemRef` is a
// one-time nonce. It prints only the protocol envelope on stdout and never logs.
import { z } from "zod";

const PROTOCOL = "agent-browser.plugin.v1";

const Request = z.object({
  protocol: z.string(),
  type: z.string(),
  request: z.object({ itemRef: z.string(), url: z.string() }).partial().optional(),
});
/** What the host's exchange answers with for a granted nonce. */
const Credential = z.object({ username: z.string(), password: z.string(), url: z.string() });

const reply = (body: object) =>
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ...body }));

let input: z.infer<typeof Request> | undefined;
try {
  input = Request.parse(JSON.parse(await Bun.stdin.text()));
} catch {
  input = undefined;
}
if (!input) {
  reply({ success: false, error: "invalid request" });
} else if (input.protocol !== PROTOCOL) {
  reply({ success: false, error: "unsupported protocol" });
} else if (input.type === "plugin.manifest") {
  reply({ success: true, manifest: { name: "claudebot", capabilities: ["credential.read"] } });
} else if (input.type === "credential.resolve") {
  try {
    const res = await fetch(process.argv[2] ?? "", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: input.request?.itemRef, url: input.request?.url }),
    });
    const credential = res.ok ? Credential.safeParse(await res.json()) : undefined;
    reply(
      credential?.success
        ? { success: true, credential: credential.data }
        : { success: false, error: "denied" },
    );
  } catch {
    reply({ success: false, error: "host unreachable" });
  }
} else {
  reply({ success: false, error: "unsupported request" });
}
