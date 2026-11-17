// tomte's credential plugin for the browser engine (`agent-browser.plugin.v1`, `credential.resolve`).
// The engine daemon spawns it: as `bun credential-plugin.ts <url>` from source, or as the compiled host's
// `credential-plugin <url>` subcommand. <url> is the host's loopback exchange URL, and the request's `itemRef`
// is a one-time nonce. It prints only the protocol envelope on stdout and never logs.
import { z } from "zod";

const PROTOCOL = "agent-browser.plugin.v1";

const Request = z.object({
  protocol: z.string(),
  type: z.string(),
  request: z.object({ itemRef: z.string(), url: z.string() }).partial().optional(),
});
/** What the host's exchange answers with for a granted nonce. */
const Credential = z.object({ username: z.string(), password: z.string(), url: z.string() });

const reply = (body: object) => JSON.stringify({ protocol: PROTOCOL, ...body });

/** The plugin's answer to one request, exchanging a granted nonce at `exchangeUrl`. */
export async function answerCredentialPlugin(
  exchangeUrl: string,
  requestText: string,
): Promise<string> {
  let input: z.infer<typeof Request> | undefined;
  try {
    input = Request.parse(JSON.parse(requestText));
  } catch {
    input = undefined;
  }
  if (!input) return reply({ success: false, error: "invalid request" });
  if (input.protocol !== PROTOCOL) return reply({ success: false, error: "unsupported protocol" });
  if (input.type === "plugin.manifest")
    return reply({
      success: true,
      manifest: { name: "tomte", capabilities: ["credential.read"] },
    });
  if (input.type !== "credential.resolve")
    return reply({ success: false, error: "unsupported request" });
  try {
    const res = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: input.request?.itemRef, url: input.request?.url }),
    });
    const credential = res.ok ? Credential.safeParse(await res.json()) : undefined;
    return reply(
      credential?.success
        ? { success: true, credential: credential.data }
        : { success: false, error: "denied" },
    );
  } catch {
    return reply({ success: false, error: "host unreachable" });
  }
}

/** Reads the one request from stdin and writes the answer to stdout. */
export async function runCredentialPlugin(exchangeUrl: string): Promise<void> {
  process.stdout.write(await answerCredentialPlugin(exchangeUrl, await Bun.stdin.text()));
}

if (import.meta.main) await runCredentialPlugin(process.argv[2] ?? "");
