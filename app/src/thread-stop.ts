/**
 * thread/stop settlement (design.md migration §6): idempotent stop over all
 * three entry states, the retiring-repurpose path, and the stop-raced-wake
 * edge. Extracted from worker-pool.ts (one verb, one file); the pool passes
 * itself as the ops object — state stays in one place.
 */

import type { ThreadEntry } from "./thread-table.ts";
import type { ThreadTable } from "./thread-table.ts";
import type { WorkerHandle } from "./worker-process.ts";

export interface StopOps {
  table: ThreadTable;
  emitFrame: (frame: { type: "response"; id?: string; command: string; success: boolean }) => void;
  liveWorker(threadId: string): WorkerHandle | undefined;
  armTeardownDeadline(worker: WorkerHandle): void;
  deliverCommand(command: {
    worker: WorkerHandle;
    id: string | undefined;
    command: string;
    line: string;
  }): Promise<void>;
}

export function stopThreadSettlement(
  pool: StopOps,
  cmd: { threadId: string; id?: string; cmdType: string },
): void {
  const { threadId, id: cmdId, cmdType } = cmd;
  const entry = pool.table.entry(threadId);
  if (entry === undefined) {
    // Idempotent: stopping an unknown thread succeeds silently (v0.3).
    ackStop(pool, cmdId, cmdType);
    return;
  }
  if (entry.state !== "live") {
    stopNonLiveEntry(pool, entry);
    ackStop(pool, cmdId, cmdType);
    return;
  }
  const worker = pool.liveWorker(threadId);
  if (worker === undefined) {
    pool.table.delete(threadId);
    ackStop(pool, cmdId, cmdType);
    return;
  }
  if (worker.retiring) {
    // Retirement in flight: repurpose it — close will drop the entry.
    worker.retireIntent = "stop";
    ackStop(pool, cmdId, cmdType);
    return;
  }
  worker.retireIntent = "stop";
  // Same bounded-teardown deadline as retire (design §6): a worker that
  // neither answers nor exits is force-closed and settles as stopped.
  pool.armTeardownDeadline(worker);
  const line = JSON.stringify({
    type: "thread/stop",
    threadId,
    ...(cmdId !== undefined ? { id: cmdId } : {}),
  });
  void pool.deliverCommand({ worker, id: cmdId, command: "thread/stop", line });
}

function ackStop(pool: StopOps, cmdId: string | undefined, cmdType: string): void {
  pool.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
}

function stopNonLiveEntry(pool: StopOps, entry: ThreadEntry): void {
  if (entry.wake === undefined) return void pool.table.delete(entry.threadId);
  // A wake is respawning this thread right now (design §6 spawning -
  // thread/stop edge): mark it so the wake lands on a stopped thread,
  // tears its worker down, and drops the re-registered entry instead
  // of resurrecting it.
  entry.stopRequested = true;
  void entry.wake.catch(() => {}).finally(() => pool.table.delete(entry.threadId));
}
