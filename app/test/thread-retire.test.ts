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
    rssRetireBytes: 0,
    workerStaleMs: 30_000,
    workerExitTimeoutMs: 10_000,
    killWorker: async (worker, intent) => {
      killed.push({ uid: worker.uid, intent });
    },
  };
  return { ops, killed };
}

function liveTable(worker: WorkerHandle, sessionPath: string | null = "/tmp/s.jsonl"): ThreadTable {
  const table = new ThreadTable();
  table.registerParked({
    threadId: worker.threadId,
    cwd: "/tmp",
    sessionPath,
    trusted: false,
  });
  // registerLive stores the passed handle: sweep identity checks compare
  // against it, so the swept worker must be the registered instance.
  table.registerLive(worker, { threadId: worker.threadId, cwd: "/tmp", sessionPath }, () => {});
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

/**
 * RSS 硬顶回收（2026-09-12-perf 方案）：worker 心跳上报的 rssBytes ≥ 阈值
 * （>0）即回收——硬顶语义：无视 keepalive 与 busy（机器保护优先于会话
 * 连续性），走 idle/manual 同一 retireWorker 入口（reason "rss"，close 结算
 * 恰好一次 thread_parked）。阈值 0 = 关闭。
 */
function rssSweep(worker: WorkerHandle, table: ThreadTable, rssRetireBytes: number) {
  const killed: Array<{ uid: string; intent: string }> = [];
  const ops: SweepOps = {
    table,
    grantLedger: { expire: () => {} } as SweepOps["grantLedger"],
    workers: () => [worker],
    idleRetireMs: 1_000,
    rssRetireBytes,
    workerStaleMs: 30_000,
    workerExitTimeoutMs: 10_000,
    killWorker: async (w, intent) => {
      killed.push({ uid: w.uid, intent });
    },
  };
  sweepWorkers(ops);
  return killed;
}

describe("sweep RSS hard cap", () => {
  test("超顶即回收（reason rss，kill 不触发）", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: 500 * 1024 * 1024 });
    const table = liveTable(worker);
    const killed = rssSweep(worker, table, 400 * 1024 * 1024);
    expect(worker.retiring).toBe(true);
    expect(worker.retireReason).toBe("rss");
    expect(killed).toEqual([]);
  });

  test("硬顶无视 keepalive 与 busy", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: 500 * 1024 * 1024, idleMs: 0 });
    const table = liveTable(worker);
    expect(table.setKeepalive("t1", true)).toBe(true);
    rssSweep(worker, table, 400 * 1024 * 1024);
    expect(worker.retiring).toBe(true); // keepalive 只挡 idle 回收，不挡硬顶
  });

  test("阈值 0 = 关闭：任意 RSS 不动作", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: 99 * 1024 ** 3 });
    const table = liveTable(worker);
    rssSweep(worker, table, 0);
    expect(worker.retiring).toBe(false);
  });

  test("低于阈值不动作（含恰好等于 = 不回收）", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: 100 * 1024 * 1024, idleMs: 0 });
    const table = liveTable(worker);
    rssSweep(worker, table, 200 * 1024 * 1024);
    expect(worker.retiring).toBe(false);
    const exact = makeWorker({ threadId: "t2", rssBytes: 200 * 1024 * 1024, idleMs: 0 });
    rssSweep(exact, liveTable(exact), 200 * 1024 * 1024);
    expect(exact.retiring).toBe(true); // ≥ 阈值即回收（等于也算超）
  });

  test("stale 心跳优先走 kill 分支（硬顶不越级）", () => {
    const worker = makeWorker({
      threadId: "t1",
      rssBytes: 500 * 1024 * 1024,
      lastHeartbeatAt: Date.now() - 60_000,
    });
    const table = liveTable(worker);
    const killed = rssSweep(worker, table, 400 * 1024 * 1024);
    expect(killed).toEqual([{ uid: worker.uid, intent: "none" }]);
    expect(worker.retiring).toBe(false);
  });

  test("未落盘（sessionPath null）超顶 worker 走 kill 而非 retire——不产生永久僵尸", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: 500 * 1024 * 1024, sessionPath: null });
    const table = liveTable(worker, null); // 未落盘：entry 与 handle 都无会话文件
    const killed = rssSweep(worker, table, 400 * 1024 * 1024);
    // retire 会 park 一个永远无法唤醒的条目（无会话文件）；kill 走 thread_died
    // 的诚实失败路径，与 stale/spawn-deadline 同一处置。
    expect(killed).toEqual([{ uid: worker.uid, intent: "none" }]);
    expect(worker.retiring).toBe(false);
  });

  test("rssBytes 未知（null）不动作", () => {
    const worker = makeWorker({ threadId: "t1", rssBytes: null });
    const table = liveTable(worker);
    rssSweep(worker, table, 400 * 1024 * 1024);
    expect(worker.retiring).toBe(false);
  });
});
