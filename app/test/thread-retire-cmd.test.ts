import { describe, expect, test } from "bun:test";
import { retireThreadSettlement } from "../src/thread-retire-cmd.ts";
import { ThreadTable } from "../src/thread-table.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * thread/retire settlement (v0.13): idempotent over all entry states, a
 * racing stop wins, and a racing idle retire upgrades its reason to manual.
 */

function makeWorker(threadId: string): WorkerHandle {
  return {
    child: {} as WorkerHandle["child"],
    uid: "w-test",
    stdin: {
      end: () => {
        workerEnded.push(threadId);
      },
      write: () => true,
    },
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
    rssBytes: null,
    retireReason: null,
    pendingIds: new Map(),
    internalIds: new Set(),
    greeted: true,
  };
}

const workerEnded: string[] = [];

function makeOps(table: ThreadTable, worker?: WorkerHandle) {
  const frames: Array<{ type: string; id?: string; command: string; success: boolean }> = [];
  const armed: string[] = [];
  return {
    frames,
    ops: {
      table,
      emitFrame: (frame: { type: "response"; id?: string; command: string; success: boolean }) => {
        frames.push(frame);
      },
      liveWorker: (threadId: string) => (worker?.threadId === threadId ? worker : undefined),
      armTeardownDeadline: (target: WorkerHandle) => {
        armed.push(target.uid);
      },
    },
    armed,
  };
}

function liveTable(worker: WorkerHandle): ThreadTable {
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
  return table;
}

describe("thread/retire settlement", () => {
  test("unknown thread acks success (idempotent, aligned with thread/stop)", () => {
    const { ops, frames } = makeOps(new ThreadTable());
    retireThreadSettlement(ops, { threadId: "missing", id: "r1", cmdType: "thread/retire" });
    expect(frames).toEqual([
      { type: "response", id: "r1", command: "thread/retire", success: true },
    ]);
  });

  test("parked entry acks success with zero side effects", () => {
    const table = new ThreadTable();
    table.registerParked({
      threadId: "p1",
      cwd: "/tmp",
      sessionPath: "/tmp/s.jsonl",
      trusted: false,
    });
    const { ops, frames, armed } = makeOps(table);
    retireThreadSettlement(ops, { threadId: "p1", id: "r2", cmdType: "thread/retire" });
    expect(frames[0]?.success).toBe(true);
    expect(armed).toEqual([]);
  });

  test("live worker retires manually: stdin closed, teardown armed, ack immediate", () => {
    const worker = makeWorker("t1");
    const { ops, frames, armed } = makeOps(liveTable(worker), worker);
    retireThreadSettlement(ops, { threadId: "t1", id: "r3", cmdType: "thread/retire" });
    expect(worker.retiring).toBe(true);
    expect(worker.retireIntent).toBe("retire");
    expect(worker.retireReason).toBe("manual");
    expect(workerEnded).toEqual(["t1"]);
    expect(armed.length).toBe(1);
    expect(frames[0]?.success).toBe(true);
  });

  test("an in-flight stop (dispose) wins — retire does not resurrect the entry", () => {
    const worker = makeWorker("t2");
    worker.retiring = true;
    worker.retireIntent = "stop";
    const { ops } = makeOps(liveTable(worker), worker);
    retireThreadSettlement(ops, { threadId: "t2", id: "r4", cmdType: "thread/retire" });
    expect(worker.retireIntent).toBe("stop");
    expect(worker.retireReason).toBeNull();
  });

  test("P1-1 回归：wake 在飞时 retire 置后置收编（唤醒落地即收编，不 success-lie）", async () => {
    const worker = makeWorker("t-wake");
    const table = liveTable(worker);
    // 构造 wake 在飞：表项 parked + wake promise 未决；落地后 liveWorker 可见
    const entry = table.entry("t-wake");
    if (entry === undefined) throw new Error("entry missing");
    let landWake: (() => void) | undefined;
    entry.state = "parked";
    entry.wake = new Promise<void>((resolve) => {
      landWake = resolve;
    });
    const { ops, frames } = makeOps(table, worker);
    retireThreadSettlement(ops, { threadId: "t-wake", id: "rw1", cmdType: "thread/retire" });
    // 先 ack；worker 尚未注册为 live，不收编
    expect(frames[0]?.success).toBe(true);
    expect(worker.retiring).toBe(false);
    // 唤醒落地（registerLive 使 liveWorker 命中）→ 后置收编执行
    entry.state = "live";
    landWake?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(worker.retiring).toBe(true);
    expect(worker.retireReason).toBe("manual");
  });

  test("P1-2 回归：未落盘会话（sessionPath=null）retire 拒绝 failure", () => {
    const worker = makeWorker("t-nofile");
    const table = liveTable(worker);
    // registerLive 的 reoccupy 会回写 sessionPath——置 null 必须在建表之后
    worker.sessionPath = null;
    const { ops, frames, armed } = makeOps(table, worker);
    retireThreadSettlement(ops, { threadId: "t-nofile", id: "rn1", cmdType: "thread/retire" });
    expect(frames[0]?.success).toBe(false);
    expect(frames[0]?.error).toContain("not persisted");
    expect(worker.retiring).toBe(false);
    expect(armed).toEqual([]);
  });

  test("an in-flight idle retire upgrades its reason to manual", () => {
    const worker = makeWorker("t3");
    worker.retiring = true;
    worker.retireIntent = "retire";
    worker.retireReason = "idle";
    const { ops, frames } = makeOps(liveTable(worker), worker);
    retireThreadSettlement(ops, { threadId: "t3", id: "r5", cmdType: "thread/retire" });
    expect(worker.retireReason).toBe("manual");
    expect(frames[0]?.success).toBe(true);
  });
});
