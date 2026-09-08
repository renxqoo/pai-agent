import { describe, expect, test } from "bun:test";
import { GrantLedger } from "../src/grant-ledger.ts";
import type { WorkerHandle } from "../src/worker-process.ts";

/**
 * v0.6 grant ledger (design.md v0.6 / migration §3 addendum): table-driven
 * over the lease lifecycle — grant/deny at the cap, release, TTL expiry
 * (via the constructor's leaseMs test seam), heartbeat renewal, and
 * worker-death reclaim.
 */

function makeWorker(tag: string): WorkerHandle {
  return {
    child: {} as WorkerHandle["child"],
    uid: tag,
    stdin: { end: () => {}, write: () => true },
    threadId: tag,
    trusted: true,
    writeLine: async () => {},
    closed: Promise.resolve(),
    retireIntent: "none",
    retiring: false,
    awaitingStart: false,
    spawnDeadline: 0,
    spawnError: undefined,
    lastHeartbeatAt: 0,
    idleMs: 0,
    streaming: false,
    sessionPath: null,
    subagents: 0,
    pendingIds: new Map(),
    internalIds: new Set(),
  };
}

const acquireFrame = (id: string) => ({ type: "grant" as const, id, n: 1 });
const releaseFrame = (id: string) => ({ type: "grant" as const, id, n: 1, release: true });

describe("grant ledger (v0.6)", () => {
  test("grants up to the cap then denies without queueing", () => {
    const ledger = new GrantLedger(2);
    const a = ledger.apply(makeWorker("w1"), acquireFrame("g1"));
    const b = ledger.apply(makeWorker("w1"), acquireFrame("g2"));
    const c = ledger.apply(makeWorker("w2"), acquireFrame("g3"));
    expect(a?.granted).toBe(true);
    expect(b?.granted).toBe(true);
    expect(c?.granted).toBe(false);
    expect(ledger.running()).toBe(2);
  });

  test("release frees the slot for the next acquire", () => {
    const ledger = new GrantLedger(1);
    expect(ledger.apply(makeWorker("w1"), acquireFrame("g1"))?.granted).toBe(true);
    expect(ledger.apply(makeWorker("w2"), acquireFrame("g2"))?.granted).toBe(false);
    expect(ledger.apply(makeWorker("w1"), releaseFrame("g1"))).toBeUndefined();
    expect(ledger.running()).toBe(0);
    expect(ledger.apply(makeWorker("w2"), acquireFrame("g3"))?.granted).toBe(true);
  });

  test("expired leases stop counting and are reclaimed by the sweep pass", async () => {
    const ledger = new GrantLedger(1, 5);
    expect(ledger.apply(makeWorker("w1"), acquireFrame("g1"))?.granted).toBe(true);
    await new Promise((done) => {
      setTimeout(done, 10);
    });
    expect(ledger.running()).toBe(0);
    expect(ledger.apply(makeWorker("w2"), acquireFrame("g2"))?.granted).toBe(true);
    ledger.expire();
  });

  test("heartbeat renewal keeps a live worker's lease past the TTL", async () => {
    const ledger = new GrantLedger(1, 30);
    const worker = makeWorker("w1");
    expect(ledger.apply(worker, acquireFrame("g1"))?.granted).toBe(true);
    // Renew every 10ms like a subagents>0 heartbeat: never expires.
    for (let i = 0; i < 5; i++) {
      await new Promise((done) => {
        setTimeout(done, 10);
      });
      ledger.renew(worker);
    }
    expect(ledger.running()).toBe(1);
  });

  test("worker close reclaims every lease it held", () => {
    const ledger = new GrantLedger(3);
    const worker = makeWorker("w1");
    expect(ledger.apply(worker, acquireFrame("g1"))?.granted).toBe(true);
    expect(ledger.apply(worker, acquireFrame("g2"))?.granted).toBe(true);
    expect(ledger.apply(makeWorker("w2"), acquireFrame("g3"))?.granted).toBe(true);
    ledger.freeWorker(worker);
    expect(ledger.running()).toBe(1);
  });

  test("acquire reply echoes the grant id with the decision", () => {
    const grant = new GrantLedger(1).apply(makeWorker("w1"), acquireFrame("g-7"));
    expect(grant?.replyLine).toBe('{"id":"g-7","type":"grant_result","granted":true}');
    const deny = new GrantLedger(0).apply(makeWorker("w1"), acquireFrame("g-9"));
    expect(deny?.replyLine).toBe('{"id":"g-9","type":"grant_result","granted":false,"running":0}');
  });

  // Adversarial review #1: grant ids are only worker-locally unique — the
  // ledger MUST keep both workers' "g-1" leases independent.
  test("same grant id from two workers stays two independent leases", () => {
    const ledger = new GrantLedger(2);
    const w1 = makeWorker("w1");
    const w2 = makeWorker("w2");
    expect(ledger.apply(w1, acquireFrame("g-1"))?.granted).toBe(true);
    expect(ledger.apply(w2, acquireFrame("g-1"))?.granted).toBe(true);
    expect(ledger.running()).toBe(2);
    ledger.apply(w1, releaseFrame("g-1"));
    expect(ledger.running()).toBe(1);
    // w2's lease must have survived w1's same-id release.
    expect(ledger.apply(w1, acquireFrame("g-1"))?.granted).toBe(true);
    expect(ledger.running()).toBe(2);
    ledger.freeWorker(w2);
    expect(ledger.running()).toBe(1);
  });
});
