/**
 * JSONL record splitter: LF is the only delimiter, trailing CR is stripped,
 * empty lines are ignored. U+2028/U+2029 are ordinary characters (Node's
 * readline is not protocol-compliant for this reason). Lines longer than
 * MAX_LINE_BYTES are dropped whole and reported via onOverflow so a
 * misbehaving peer cannot grow the buffer without bound.
 */

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface JsonlSplitter {
  /** Feed a chunk; complete lines are emitted synchronously. */
  push(chunk: string): void;
  /** Emit a final non-empty line left in the buffer (no trailing LF). */
  flush(): void;
}

export function createJsonlSplitter(
  onLine: (line: string) => void,
  onOverflow?: (limit: number) => void,
): JsonlSplitter {
  let buffer = "";
  let dropping = false;
  return {
    push(chunk: string): void {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          if (buffer.length > MAX_LINE_BYTES) {
            dropping = true;
            buffer = "";
            onOverflow?.(MAX_LINE_BYTES);
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
        if (line.length > MAX_LINE_BYTES) {
          onOverflow?.(MAX_LINE_BYTES);
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
