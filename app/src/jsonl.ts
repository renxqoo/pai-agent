/**
 * JSONL record splitter: LF is the only delimiter, trailing CR is stripped,
 * empty lines are ignored. U+2028/U+2029 are ordinary characters (Node's
 * readline is not protocol-compliant for this reason). Lines longer than
 * maxLineBytes (utf-8 BYTES, not code units — a 60-CJK-char line is 180
 * bytes, not 60) are dropped whole and reported via onOverflow exactly once
 * per dropped line, so a misbehaving peer cannot grow the buffer without
 * bound. Byte accounting is incremental: the buffered bytes are measured
 * once on arrival/consumption, never re-scanned per push.
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

interface SplitterState {
  buffer: string;
  bufferBytes: number;
  dropping: boolean;
}

/** CR strip + empty-line skip (the emit half shared by push and flush). */
function emitLine(onLine: (line: string) => void, line: string): void {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (stripped.length > 0) onLine(stripped);
}

/** Concatenating a high-surrogate tail with a low-surrogate head joins two
 * 3-byte replacement encodings into one 4-byte pair — the running byte total
 * must discount the joined pair or it overcounts and drops short lines. */
function joinedPairDiscount(head: string, tail: string): number {
  if (head.length === 0 || tail.length === 0) return 0;
  const last = head.charCodeAt(head.length - 1);
  const first = tail.charCodeAt(0);
  const joinsPair = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  return joinsPair ? 2 : 0;
}

/** The fixed per-splitter wiring pushChunk needs (kept off the params list). */
interface SplitterHooks {
  onLine: (line: string) => void;
  onOverflow: (limit: number) => void;
  maxLineBytes: number;
}

function pushChunk(state: SplitterState, chunk: string, hooks: SplitterHooks): void {
  const { onLine, onOverflow, maxLineBytes } = hooks;
  state.bufferBytes += Buffer.byteLength(chunk, "utf8") - joinedPairDiscount(state.buffer, chunk);
  state.buffer += chunk;
  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex === -1) {
      if (state.bufferBytes > maxLineBytes) {
        // First detection only: later chunks of the same oversized line
        // must not re-report (chunk-count independence).
        if (!state.dropping) onOverflow(maxLineBytes);
        state.dropping = true;
        state.buffer = "";
        state.bufferBytes = 0;
      }
      return;
    }
    const consumed = state.buffer.slice(0, newlineIndex + 1);
    state.buffer = state.buffer.slice(newlineIndex + 1);
    state.bufferBytes -= Buffer.byteLength(consumed, "utf8");
    if (state.dropping) {
      state.dropping = false; // the dropped line's tail ends here: nothing to emit
      continue;
    }
    const line = consumed.slice(0, -1);
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      onOverflow(maxLineBytes);
      continue;
    }
    emitLine(onLine, line);
  }
}

export function createJsonlSplitter(
  onLine: (line: string) => void,
  onOverflow?: (limit: number) => void,
  maxLineBytes: number = MAX_LINE_BYTES,
): JsonlSplitter {
  const state: SplitterState = { buffer: "", bufferBytes: 0, dropping: false };
  const hooks: SplitterHooks = {
    onLine,
    onOverflow: onOverflow ?? (() => {}),
    maxLineBytes,
  };
  return {
    push: (chunk: string): void => pushChunk(state, chunk, hooks),
    flush(): void {
      const line = state.dropping ? "" : state.buffer;
      state.dropping = false;
      state.buffer = "";
      state.bufferBytes = 0;
      emitLine(onLine, line);
    },
  };
}
