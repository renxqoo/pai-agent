import { describe, expect, test } from "bun:test";
import { retireWorker, sweepWorkers, type SweepOps } from "../src/thread-retire.ts";
import { ThreadTable } from "../src/thread-table.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * v0.13 idle-retire: the keepalive guard and the shared retireWorker entry
 * point (reason feeds the thread_parked frame from close settlement).
 */

function makeWorker(overrides: Partial<WorkerHandle> = {}): WorkerHandle {
  return {
    child: {} as WorkerHandle["child"],
    uid: "w-test",
    stdin: { end: () => {}, write: () => true },
    threadId: "t1",
    trusted: true,
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
    rssBytes: null,
    retireReason: null,
    pendingIds: new Map(),
    internalIds: new Set(),
    greeted: true,
    ...overrides,
  };
}

function makeSweep(
  table: ThreadTable,
  workers: WorkerHandle[],
): {
  ops: SweepOps;
  killed: Array<{ uid: string; intent: string }>;
} {
  const killed: Array<{ uid: string; intent: string }> = [];
  const ops: SweepOps = {
    table,
    // The grant ledger only needs expire() on the sweep path.
    grantLedger: { expire: () => {} } as SweepOps["grantLedger"],
    workers: () => workers,
    idleRetireMs: 1_000,
    workerStaleMs: 30_000,
    workerExitTimeoutMs: 10_000,
    killWorker: async (worker, intent) => {
      killed.push({ uid: worker.uid, intent });
    },
  };
  return { ops, killed };
}

function liveTable(worker: WorkerHandle): ThreadTable {
  const table = new ThreadTable();
  table.registerParked({
    threadId: worker.threadId,
    cwd: "/tmp",
    sessionPath: "/tmp/s.jsonl",
    trusted: false,
  });
  // registerLive stores the passed handle: sweep identity checks compare
  // against it, so the swept worker must be the registered instance.
  table.registerLive(
    worker,
    { threadId: worker.threadId, cwd: "/tmp", sessionPath: "/tmp/s.jsonl" },
    () => {},
  );
  return table;
}

describe("sweep keepalive guard (v0.13)", () => {
  test("an idle keepalive worker is NOT retired", () => {
    const worker = makeWorker({ threadId: "t1", idleMs: 60_000 });
    const table = liveTable(worker);
    expect(table.setKeepalive("t1", true)).toBe(true);
    const { ops } = makeSweep(table, [worker]);
    sweepWorkers(ops);
    expect(worker.retiring).toBe(false);
  });

  test("an idle worker without keepalive retires with reason idle", () => {
    const worker = makeWorker({ threadId: "t1", idleMs: 60_000 });
    const table = liveTable(worker);
    const { ops } = makeSweep(table, [worker]);
    sweepWorkers(ops);
    expect(worker.retiring).toBe(true);
    expect(worker.retireIntent).toBe("retire");
    expect(worker.retireReason).toBe("idle");
  });

  test("stale-heartbeat kills still apply to keepalive workers", () => {
    const worker = makeWorker({ threadId: "t1", lastHeartbeatAt: Date.now() - 60_000 });
    const table = liveTable(worker);
    expect(table.setKeepalive("t1", true)).toBe(true);
    const { ops, killed } = makeSweep(table, [worker]);
    sweepWorkers(ops);
    expect(worker.retiring).toBe(false);
    expect(killed).toEqual([{ uid: worker.uid, intent: "none" }]);
  });
});

describe("retireWorker (shared entry point)", () => {
  test("marks retiring with intent and reason, closes stdin", () => {
    const worker = makeWorker();
    const armed: string[] = [];
    retireWorker({ armTeardownDeadline: (target) => armed.push(target.uid) }, worker, "manual");
    expect(worker.retiring).toBe(true);
    expect(worker.retireIntent).toBe("retire");
    expect(worker.retireReason).toBe("manual");
    expect(armed).toEqual([worker.uid]);
  });

  test("a worker already retiring (any intent) is untouched", () => {
    const worker = makeWorker({ retiring: true, retireIntent: "stop" });
    retireWorker({ armTeardownDeadline: () => {} }, worker, "manual");
    expect(worker.retireIntent).toBe("stop");
    expect(worker.retireReason).toBeNull();
  });
});

describe("fork does not inherit keepalive (P1-3 回归)", () => {
  test("rekeyFork clears the flag on the migrated entry", () => {
    const table = liveTable(makeWorker({ threadId: "a" }));
    expect(table.setKeepalive("a", true)).toBe(true);
    const worker = makeWorker({ threadId: "b" });
    table.rekeyFork(worker, { threadId: "b", previousThreadId: "a", sessionPath: "/tmp/b.jsonl" });
    expect(table.entry("a")).toBeUndefined();
    expect(table.entry("b")?.keepalive).toBe(false);
  });
});
