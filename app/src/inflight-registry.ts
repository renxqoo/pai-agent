/**
 * In-flight long-operation registry shared by the host (auth) and the worker
 * (bash/compact): shutdown aborts every tracked operation and waits for
 * their responses to be emitted, so every accepted command keeps its
 * exactly-one response guarantee.
 */

export interface InflightHandle {
  done: () => void;
  unregister: () => void;
}

export type RegisterInflight = (abort: () => void) => InflightHandle;

export interface InflightRegistry {
  register: RegisterInflight;
  /** Count of in-flight long operations (idle computation). */
  size(): number;
  /** Abort everything and wait for their responses to be emitted (shutdown). */
  abortAll(): Promise<void>;
}

interface InflightOp {
  abort: () => void;
  done: Promise<void>;
}

export function createInflightRegistry(): InflightRegistry {
  const ops = new Map<number, InflightOp>();
  let seq = 0;
  return {
    register(abort: () => void) {
      seq += 1;
      let markDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      ops.set(seq, { abort, done });
      return {
        done: () => markDone?.(),
        unregister: () => {
          markDone?.();
          ops.delete(seq);
        },
      };
    },
    size() {
      return ops.size;
    },
    async abortAll() {
      for (const op of Array.from(ops.values())) op.abort();
      await Promise.allSettled(Array.from(ops.values()).map((op) => op.done));
    },
  };
}
