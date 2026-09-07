/**
 * stdout takeover + serialized protocol frame writer.
 *
 * The protocol owns stdout; stray output is rerouted to stderr so it cannot
 * corrupt the JSONL stream (mirrors pi's built-in RPC mode). Two layers:
 * - process.stdout.write is patched (covers SDK/library writes);
 * - global console methods are patched too — under Bun, console.* does not
 *   route through process.stdout.write and would otherwise reach fd 1
 *   directly. Direct fd/Bun.write calls cannot be caught (documented gap).
 *
 * Frames are written strictly in invocation order; a full pipe is retried
 * after a short delay (ENOBUFS/EAGAIN are transient), while a real
 * disconnection (EPIPE etc.) rejects so the hub can shut down.
 */

export type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

const RETRY_DELAY_MS = 10;

let rawStdoutWrite: RawWrite | undefined;
let rawStderrWrite: RawWrite | undefined;

export function takeOverStdout(): void {
  if (rawStdoutWrite) return;
  rawStdoutWrite = process.stdout.write.bind(process.stdout) as RawWrite;
  rawStderrWrite = process.stderr.write.bind(process.stderr) as RawWrite;
  process.stdout.write = ((chunk: unknown, callback?: (error?: Error | null) => void) =>
    rawStderrWrite!(String(chunk), callback)) as unknown as typeof process.stdout.write;

  const toStderr = (...args: unknown[]): void => {
    rawStderrWrite?.(`${args.map(String).join(" ")}\n`);
  };
  const consoleShim = {
    log: toStderr,
    info: toStderr,
    debug: toStderr,
    warn: toStderr,
    error: toStderr,
  };
  for (const [name, fn] of Object.entries(consoleShim)) {
    // @ts-expect-error assigning shim onto the console object
    globalThis.console[name] = fn;
  }
}

export function getRawStdoutWrite(): RawWrite {
  if (!rawStdoutWrite) throw new Error("takeOverStdout() must run first");
  return rawStdoutWrite;
}

export function writeStderr(text: string): void {
  rawStderrWrite?.(text);
}

export interface FrameWriter {
  /** Enqueue one frame; resolves once the frame has been handed to the OS. */
  write(text: string): Promise<void>;
  /** Resolves when every queued frame has been written. */
  flush(): Promise<void>;
}

function isTransient(error: Error): boolean {
  const code = (error as Error & { code?: unknown }).code;
  return code === "ENOBUFS" || code === "EAGAIN" || code === "EWOULDBLOCK";
}

/**
 * Serializes frames onto a raw write function. A failed frame rejects its
 * own promise (the caller decides whether that is fatal) but does not break
 * the chain for later frames.
 */
export function createFrameWriter(write: RawWrite): FrameWriter {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = async (text: string): Promise<void> => {
    // Retry loop mirrors pi's output-guard: a full pipe reports
    // ENOBUFS/EAGAIN via the callback and clears on its own.
    for (;;) {
      const error = await new Promise<Error | null>((resolve) => {
        let settled = false;
        const done = (error?: Error | null): void => {
          if (settled) return;
          settled = true;
          resolve(error ?? null);
        };
        try {
          write(text, done);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (error === null) return;
      if (isTransient(error)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  };

  return {
    write(text: string): Promise<void> {
      tail = tail.then(
        () => enqueue(text),
        () => enqueue(text),
      );
      return tail;
    },
    flush(): Promise<void> {
      return tail;
    },
  };
}
