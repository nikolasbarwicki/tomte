/** A failure the user can act on, with a message written for the Connections page: a refused URL, a version mismatch, a wrong pairing code, an unreachable host. Anything else is a bug and stays a plain `Error`. */
export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
}
