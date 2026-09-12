import { describe, expect, test } from "bun:test";
import type { HubFrame } from "../src/protocol.ts";
import { WorkerPool } from "../src/worker-pool.ts";
import { hostHandlers } from "../src/host-commands.ts";

/**
 * v0.13 host-local observability surface: thread/list row fields, the
 * keepalive flag round-trip, and the idle-retire threshold clamp. No workers
 * are spawned — these are pure table/pool projections.
 */

function makePool(): { pool: WorkerPool; frames: HubFrame[] } {
  const frames: HubFrame[] = [];
  const pool = new WorkerPool({
    emitFrame: (frame) => {
      frames.push(frame);
    },
    emitRaw: () => {},
    writeStderr: () => {},
    idleRetireMs: 5_000,
  });
  return { pool, frames };
}

function parked(pool: WorkerPool, threadId: string): void {
  pool.registerParked({ threadId, cwd: "/tmp", sessionPath: "/tmp/s.jsonl", trusted: false });
}

describe("thread/list observability fields (v0.13)", () => {
  test("a parked row reports zeroed facts and keepalive false", async () => {
    const { pool } = makePool();
    parked(pool, "p1");
    const [row] = pool.listEntries();
    expect(row).toMatchObject({
      threadId: "p1",
      state: "parked",
      isStreaming: false,
      idleMs: 0,
      subagents: 0,
      rssBytes: null,
      keepalive: false,
    });
    await pool.shutdownAll();
  });

  test("setKeepalive round-trips into the row; unknown threads fail", async () => {
    const { pool } = makePool();
    parked(pool, "p2");
    expect(pool.setKeepalive("p2", true)).toBe(true);
    expect(pool.listEntries()[0]?.keepalive).toBe(true);
    expect(pool.setKeepalive("p2", false)).toBe(true);
    expect(pool.listEntries()[0]?.keepalive).toBe(false);
    expect(pool.setKeepalive("missing", true)).toBe(false);
    await pool.shutdownAll();
  });
});

describe("set_idle_retire_ms clamp (v0.13)", () => {
  test.each([
    [500, 1_000],
    [0, 1_000],
    [-5, 1_000],
    [5_000, 5_000],
    [900_000, 900_000],
    [999_999_999, 86_400_000],
    [Number.NaN, 900_000],
  ])("ms=%p applies %p", async (input: number, applied: number) => {
    const { pool } = makePool();
    expect(pool.setIdleRetireMs(input)).toBe(applied);
    expect(pool.limits().idleRetireMs).toBe(applied);
    await pool.shutdownAll();
  });
});

/** RSS 硬顶阈值（2026-09-12-perf 方案）：clamp 表 + limits 回显 + 命令 handler。 */
describe("set_rss_retire_bytes (rss hard cap)", () => {
  test.each([
    [0, 0],
    [-1, 0],
    [1, 256 * 1024 * 1024],
    [100 * 1024 * 1024, 256 * 1024 * 1024],
    [256 * 1024 * 1024, 256 * 1024 * 1024],
    [3 * 1024 ** 4, 2 * 1024 ** 4], // 上界 2 TiB（不是 GiB）
    [2 * 1024 ** 4, 2 * 1024 ** 4],
    [Number.NaN, 0],
  ])("bytes=%p applies %p", async (input: number, applied: number) => {
    const { pool } = makePool();
    expect(pool.setRssRetireBytes(input)).toBe(applied);
    expect(pool.limits().rssRetireBytes).toBe(applied);
    await pool.shutdownAll();
  });

  test("env 缺省 0=关（opt-in）；env 值同样过 clamp（防死循环）；handler 回 applied，非法输入 failure", async () => {
    const { pool } = makePool();
    expect(pool.limits().rssRetireBytes).toBe(0);
    process.env.PAI_RSS_RETIRE_BYTES = "1"; // 病态值：clamp 后不得造成秒回收死循环
    try {
      const hostile = new WorkerPool({
        emitFrame: () => {},
        emitRaw: () => {},
        writeStderr: () => {},
      });
      expect(hostile.limits().rssRetireBytes).toBe(256 * 1024 * 1024);
      await hostile.shutdownAll();
    } finally {
      delete process.env.PAI_RSS_RETIRE_BYTES;
    }
    const handler = hostHandlers.get("set_rss_retire_bytes");
    expect(handler).toBeDefined();
    const frames: unknown[] = [];
    const deps = {
      emit: (frame: unknown) => {
        frames.push(frame);
      },
      pool,
    } as never;
    await handler?.(deps, { type: "set_rss_retire_bytes", bytes: 512 * 1024 * 1024 }, "q1");
    await handler?.(deps, { type: "set_rss_retire_bytes", bytes: "big" }, "q2");
    expect(frames).toEqual([
      {
        type: "response",
        id: "q1",
        command: "set_rss_retire_bytes",
        success: true,
        data: { rssRetireBytes: 512 * 1024 * 1024 },
      },
      {
        type: "response",
        id: "q2",
        command: "set_rss_retire_bytes",
        success: false,
        error: "Invalid bytes",
      },
    ]);
    await pool.shutdownAll();
  });
});
