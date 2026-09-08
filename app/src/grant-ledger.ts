/**
 * v0.6 global running-grandchild cap: the host-side grant ledger
 * (design.md v0.6 / migration §3 addendum). One lease per RUNNING
 * grandchild; synchronous single-event-loop accounting — no locks. Leases
 * are heartbeat-renewed while their worker still reports subagents, expire
 * after the TTL (leak self-healing), and are freed on worker close.
 */

import type { WorkerGrantFrame } from "./protocol.ts";
import type { WorkerHandle } from "./worker-process.ts";

export const MAX_SUBAGENTS_DEFAULT = 16;
/** Heartbeat-renewed while the worker reports subagents; a forgotten
 * release self-heals after this window. */
export const GRANT_LEASE_MS = 300_000;

/** One running-grandchild slot held by a worker (grant id -> lease). */
interface GrantLease {
  worker: WorkerHandle;
  n: number;
  expiresAt: number;
}

export interface GrantDecision {
  granted: boolean;
  /** Running count at decision time (denial message context for the model). */
  running: number;
  /** Reply line for the worker (internal command; its ack is absorbed). */
  replyLine: string;
}

export class GrantLedger {
  private readonly maxSubagents: number;
  /** Test seam: shrink the TTL to exercise expiry without wall-clock waits. */
  private readonly leaseMs: number;
  private readonly leases = new Map<string, GrantLease>();

  constructor(maxSubagents: number, leaseMs: number = GRANT_LEASE_MS) {
    this.maxSubagents = maxSubagents;
    this.leaseMs = leaseMs;
  }

  limit(): number {
    return this.maxSubagents;
  }

  /** Expired leases excluded — the sweep reclaims them, reads stay honest. */
  running(): number {
    const now = Date.now();
    let total = 0;
    for (const lease of this.leases.values()) {
      if (lease.expiresAt > now) total += lease.n;
    }
    return total;
  }

  /**
   * Lease key: worker-scoped. Grant ids are only worker-LOCALLY unique
   * ("g-1" exists in every worker), so the host must never key by the raw
   * id — two workers' "g-1" would overwrite each other and silently break
   * the global cap (adversarial review #1).
   */
  private static key(worker: WorkerHandle, grantId: string): string {
    return `${worker.uid}:${grantId}`;
  }

  /** Apply one worker→host grant frame (acquire or release). */
  apply(worker: WorkerHandle, frame: WorkerGrantFrame): GrantDecision | undefined {
    const key = GrantLedger.key(worker, frame.id);
    if (frame.release === true) {
      this.leases.delete(key);
      return undefined;
    }
    const n = typeof frame.n === "number" && frame.n > 0 ? frame.n : 1;
    const running = this.running();
    const granted = running + n <= this.maxSubagents;
    if (granted) {
      this.leases.set(key, { worker, n, expiresAt: Date.now() + this.leaseMs });
    }
    return {
      granted,
      running,
      replyLine: JSON.stringify({
        id: frame.id,
        type: "grant_result",
        granted,
        ...(granted ? {} : { running }),
      }),
    };
  }

  /** Heartbeat lease renewal: a worker reporting subagents keeps its leases. */
  renew(worker: WorkerHandle): void {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (lease.worker === worker && lease.expiresAt > now) {
        lease.expiresAt = now + this.leaseMs;
      }
    }
  }

  /** TTL pass (called from the pool's existing sweep — no new global timer). */
  expire(): void {
    const now = Date.now();
    for (const [id, lease] of Array.from(this.leases)) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }

  /** Worker death/close: its leases die with it. */
  freeWorker(worker: WorkerHandle): void {
    for (const [id, lease] of Array.from(this.leases)) {
      if (lease.worker === worker) this.leases.delete(id);
    }
  }
}
