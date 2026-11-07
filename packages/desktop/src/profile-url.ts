import { ConnectionError } from "./connection-error.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The origin a profile's URL names. Only an origin is accepted: no credentials, path, query or fragment, so what the
 * user typed is exactly what gets requested and what the window is limited to. `https:` is required, except `http:`
 * for a loopback host (an SSH tunnel to a remote host). A plain-HTTP private network is refused: the device token
 * and the session would cross it in the clear.
 */
export function parseProfileUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConnectionError(`"${text}" is not a URL. Use the form https://host.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ConnectionError(`${url.protocol} URLs are not supported. Use https://`);
  if (url.username !== "" || url.password !== "")
    throw new ConnectionError("The URL must not contain a user name or password.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]/.test(text))
    throw new ConnectionError("Enter only the host's address, without a path, query or fragment.");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
    throw new ConnectionError(
      "Plain http:// is only allowed for this computer (127.0.0.1, [::1], localhost). Use https:// for any other host.",
    );
  return url.origin;
}
