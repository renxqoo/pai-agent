import { describe, expect, test } from "bun:test";
import type { HubFrame } from "../src/protocol.ts";
import { WorkerPool } from "../src/worker-pool.ts";

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
