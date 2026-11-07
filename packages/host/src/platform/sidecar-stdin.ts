/** A launch token line is 43 characters; a first line past this many bytes with no newline is wrong however it ends, so the reader stops collecting it. */
const MAX_FIRST_LINE_BYTES = 1024;

export interface SidecarInput {
  /** The first line of the input without its line ending: the launch token, if the app sent one. Undefined when the input ends before a line arrives. */
  firstLine: Promise<string | undefined>;
  /** Settles when the input ends or fails: the app quit or crashed. Later lines are read and dropped. */
  ended: Promise<void>;
}

/** Reads the sidecar protocol's stdin: one line, then nothing that matters until the stream ends. The pipe is read for the host's whole life so that its end is seen. */
export function readSidecarInput(input: ReadableStream<Uint8Array>): SidecarInput {
  const first = Promise.withResolvers<string | undefined>();
  const ended = Promise.withResolvers<void>();
  void (async () => {
    const decoder = new TextDecoder();
    let collected = "";
    let seenLine = false;
    try {
      for await (const chunk of input) {
        if (seenLine) continue;
        collected += decoder.decode(chunk, { stream: true });
        const newline = collected.indexOf("\n");
        if (newline >= 0 || collected.length > MAX_FIRST_LINE_BYTES) {
          seenLine = true;
          first.resolve(
            collected.slice(0, newline >= 0 ? newline : MAX_FIRST_LINE_BYTES).replace(/\r$/, ""),
          );
        }
      }
    } catch {
      // A failed pipe ends the app's side of the protocol just as a closed one does.
    }
    first.resolve(undefined);
    ended.resolve();
  })();
  return { firstLine: first.promise, ended: ended.promise };
}
