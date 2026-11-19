import type { HandoffHost } from "./test-host.ts";

/**
 * `POST /api/files/upload` as the web page makes it, from the paired device: `body` streams into `path` in the open bot's
 * files folder. `folder` asks for a new folder rather than a merge (see `writeUpload`).
 */
export function uploadFile(
  host: Pick<HandoffHost, "clientUrl" | "authHeaders">,
  path: string,
  body: string | Uint8Array | Blob | ReadableStream<Uint8Array>,
  {
    folder,
    contentType = "application/octet-stream",
  }: { folder?: string; contentType?: string } = {},
): Promise<Response> {
  const query = new URLSearchParams({ path, ...(folder !== undefined && { folder }) });
  return fetch(`${host.clientUrl}/api/files/upload?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": contentType, origin: host.clientUrl, ...host.authHeaders },
    body,
  });
}
