/**
 * Idle-retire sweep (design.md migration §6; v0.12 plan update lives in
 * docs/plans/2026-09-10-parked-read-history.md context): spawn-deadline and
 * stale-heartbeat kills, idle retirement, and the bounded tear-down deadline.
 * Extracted from worker-pool.ts (one verb, one file); the pool passes itself
 * as the ops object — state stays in one place.
 */

import type { GrantLedger } from "./grant-ledger.ts";
import type { RetireIntent, WorkerHandle } from "./worker-process.ts";
import type { ThreadTable } from "./thread-table.ts";

export interface SweepOps {
  table: ThreadTable;
  grantLedger: GrantLedger;
  workers(): WorkerHandle[];
  idleRetireMs: number;
  workerStaleMs: number;
  workerExitTimeoutMs: number;
  killWorker(worker: WorkerHandle, intent: RetireIntent): Promise<void>;
}

export function sweepWorkers(pool: SweepOps): void {
  const now = Date.now();
  pool.grantLedger.expire();
  for (const worker of pool.workers()) {
    if (worker.awaitingStart && now > worker.spawnDeadline) {
      void pool.killWorker(worker, "none");
      continue;
    }
    if (pool.table.liveWorker(worker.threadId) !== worker) continue; // not live yet
    if (now - worker.lastHeartbeatAt > pool.workerStaleMs) {
      void pool.killWorker(worker, "none");
      continue;
    }
    if (
      !worker.retiring &&
      pool.table.entry(worker.threadId)?.keepalive !== true && // v0.13 keepalive skips idle retire
      worker.idleMs >= pool.idleRetireMs &&
      worker.sessionPath !== null
    ) {
      retireWorker(
        { armTeardownDeadline: (target) => armTeardownDeadline(pool, target) },
        worker,
        "idle",
      );
    }
  }
}

/** Shared retire entry point (idle sweep and thread/retire, v0.13): close the
 * worker's stdin and arm the bounded tear-down; close settlement parks the
 * entry and emits thread_parked with this reason. */
export function retireWorker(
  pool: { armTeardownDeadline(worker: WorkerHandle): void },
  worker: WorkerHandle,
  reason: "idle" | "manual",
): void {
  if (worker.retireIntent !== "none" || worker.retiring) return;
  worker.retiring = true;
  worker.retireIntent = "retire";
  worker.retireReason = reason;
  worker.stdin.end();
  pool.armTeardownDeadline(worker);
}

/** Bounded tear-down (design §6): a wedged-but-heartbeating worker would
 * outlive the sweep's stale kill line forever — force-kill it once the
 * exit budget lapses (killWorker owns SIGTERM -> SIGKILL; the timer is
 * cleared on close like every other state transition). */
export function armTeardownDeadline(pool: SweepOps, worker: WorkerHandle): void {
  const grace = setTimeout(() => void pool.killWorker(worker, "none"), pool.workerExitTimeoutMs);
  void worker.closed.finally(() => clearTimeout(grace));
}
