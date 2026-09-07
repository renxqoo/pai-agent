import { describe, expect, test } from "bun:test";
import { createFrameWriter, type RawWrite } from "../src/stdout-guard.ts";

/** Fake raw write: records frames; optionally delays or fails. */
function makeFakeWrite(options: { delayMs?: number; failOn?: string } = {}): {
  writes: string[];
  write: RawWrite;
} {
  const writes: string[] = [];
  const write: RawWrite = (chunk, callback) => {
    if (options.failOn !== undefined && chunk.includes(options.failOn)) {
      setTimeout(() => callback?.(new Error("EPIPE")), 0);
      return false;
    }
    if (options.delayMs !== undefined) {
      setTimeout(() => {
        writes.push(chunk);
        callback?.();
      }, options.delayMs);
      return false; // buffered: exercises the drain path
    }
    writes.push(chunk);
    callback?.();
    return true;
  };
  return { writes, write };
}

describe("frame writer", () => {
  test("frames are written strictly in invocation order", async () => {
    const { writes, write } = makeFakeWrite();
    const writer = createFrameWriter(write);
    // Fire without awaiting; order must still be preserved.
    const p1 = writer.write("one\n");
    const p2 = writer.write("two\n");
    const p3 = writer.write("three\n");
    await Promise.all([p1, p2, p3]);
    expect(writes).toEqual(["one\n", "two\n", "three\n"]);
  });

  test("slow first frame delays the second (serialization)", async () => {
    const { writes, write } = makeFakeWrite({ delayMs: 20 });
    const writer = createFrameWriter(write);
    let secondStarted = false;
    const p1 = writer.write("slow\n");
    const p2 = writer.write("fast\n").then(() => {
      secondStarted = true;
    });
    await p1;
    expect(writes).toEqual(["slow\n"]);
    expect(secondStarted).toBe(false);
    await p2;
    expect(writes).toEqual(["slow\n", "fast\n"]);
  });

  test("a failed frame rejects but does not break the chain", async () => {
    const { writes, write } = makeFakeWrite({ failOn: "boom" });
    const writer = createFrameWriter(write);
    const failed = writer.write("boom\n");
    await expect(failed).rejects.toThrow("EPIPE");
    // Subsequent frames still attempt delivery.
    await writer.write("after\n");
    expect(writes).toEqual(["after\n"]);
  });

  test("flush resolves once all queued frames are done", async () => {
    const { write } = makeFakeWrite({ delayMs: 10 });
    const writer = createFrameWriter(write);
    void writer.write("a\n");
    void writer.write("b\n");
    await writer.flush();
  });
});
