import { describe, expect, test } from "bun:test";
import { reconcileWorkerClosed } from "../src/worker-death.ts";
import { ThreadTable } from "../src/thread-table.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * v0.13 close-settlement frames: retirement emits thread_parked exactly once
 * with the origin reason; abnormal deaths keep thread_died; a stop (dispose)
 * stays silent and drops the entry.
 */

function makeWorker(threadId: string): WorkerHandle {
  return {
    child: {} as WorkerHandle["child"],
    stdin: { end: () => {}, write: () => true },
    threadId,
    trusted: false,
    writeLine: async () => {},
    closed: Promise.resolve(),
    retireIntent: "none",
    retiring: false,
    awaitingStart: false,
    spawnDeadline: 0,
    spawnError: undefined,
    lastHeartbeatAt: Date.now(),
    idleMs: 0,
    streaming: false,
    sessionPath: "/tmp/s.jsonl",
    subagents: 0,
    rssBytes: 1024,
    retireReason: null,
    pendingIds: new Map(),
    internalIds: new Set(),
    greeted: true,
  };
}

function settle(worker: WorkerHandle): { frames: unknown[]; table: ThreadTable } {
  const table = new ThreadTable();
  table.registerParked({
    threadId: worker.threadId,
    cwd: "/tmp",
    sessionPath: "/tmp/s.jsonl",
    trusted: false,
  });
  table.registerLive(
    worker,
    { threadId: worker.threadId, cwd: "/tmp", sessionPath: "/tmp/s.jsonl" },
    () => {},
  );
  const frames: unknown[] = [];
  reconcileWorkerClosed({
    death: {
      table,
      internalIds: new Map(),
      allWorkers: new Set([worker]),
      freeGrants: () => {},
      failure: () => {},
      emitFrame: (frame) => {
        frames.push(frame);
      },
    },
    worker,
    code: 0,
    signal: null,
    workerExitTimeoutMs: 10_000,
  });
  return { frames, table };
}

describe("close settlement frames (v0.13)", () => {
  test("idle retire parks the entry and emits thread_parked(reason idle)", () => {
    const worker = makeWorker("t-idle");
    worker.retiring = true;
    worker.retireIntent = "retire";
    worker.retireReason = "idle";
    const { frames, table } = settle(worker);
    expect(frames).toEqual([{ type: "thread_parked", threadId: "t-idle", reason: "idle" }]);
    expect(table.entry("t-idle")?.state).toBe("parked");
  });

  test("manual retire emits thread_parked(reason manual)", () => {
    const worker = makeWorker("t-manual");
    worker.retiring = true;
    worker.retireIntent = "retire";
    worker.retireReason = "manual";
    const { frames } = settle(worker);
    expect(frames).toEqual([{ type: "thread_parked", threadId: "t-manual", reason: "manual" }]);
  });

  test("a retire without a recorded reason defaults to idle", () => {
    const worker = makeWorker("t-default");
    worker.retiring = true;
    worker.retireIntent = "retire";
    const { frames } = settle(worker);
    expect(frames).toEqual([{ type: "thread_parked", threadId: "t-default", reason: "idle" }]);
  });

  test("abnormal death keeps thread_died and marks the entry dead", () => {
    const worker = makeWorker("t-died");
    const { frames, table } = settle(worker);
    expect(frames).toEqual([
      { type: "thread_died", threadId: "t-died", reason: expect.stringContaining("worker exited") },
    ]);
    expect(table.entry("t-died")?.state).toBe("dead");
  });

  test("stop (dispose) emits nothing and drops the entry", () => {
    const worker = makeWorker("t-stopped");
    worker.retiring = true;
    worker.retireIntent = "stop";
    const { frames, table } = settle(worker);
    expect(frames).toEqual([]);
    expect(table.entry("t-stopped")).toBeUndefined();
  });
});
