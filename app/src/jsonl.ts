/**
 * JSONL record splitter: LF is the only delimiter, trailing CR is stripped,
 * empty lines are ignored. U+2028/U+2029 are ordinary characters (Node's
 * readline is not protocol-compliant for this reason). Lines longer than
 * maxLineBytes are dropped whole and reported via onOverflow so a misbehaving
 * peer cannot grow the buffer without bound.
 */

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** INTERNAL host<-worker cap: single-line get_messages responses can reach
 * tens of MB; the worker is our own binary, so the trusted-channel limit is
 * higher than the Electron-facing default. */
export const WORKER_LINE_BYTES = 128 * 1024 * 1024;

interface JsonlSplitter {
  /** Feed a chunk; complete lines are emitted synchronously. */
  push(chunk: string): void;
  /** Emit a final non-empty line left in the buffer (no trailing LF). */
  flush(): void;
}

export function createJsonlSplitter(
  onLine: (line: string) => void,
  onOverflow?: (limit: number) => void,
  maxLineBytes: number = MAX_LINE_BYTES,
): JsonlSplitter {
  let buffer = "";
  let dropping = false;
  return {
    push(chunk: string): void {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          if (buffer.length > maxLineBytes) {
            dropping = true;
            buffer = "";
            onOverflow?.(maxLineBytes);
          }
          break;
        }
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (dropping) {
          // The tail of the dropped line ends here; nothing to emit.
          dropping = false;
          continue;
        }
        if (line.length > maxLineBytes) {
          onOverflow?.(maxLineBytes);
          continue;
        }
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) onLine(line);
      }
    },
    flush(): void {
      if (dropping) {
        dropping = false;
        buffer = "";
        return;
      }
      let line = buffer;
      buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    },
  };
}
