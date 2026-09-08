/**
 * Worker death reconciliation (design.md migration §6): every termination is
 * processed from the child `close` event (stdio drained), never `exit`.
 * Pending routed commands are reconciled against responses already seen and
 * only the missing ones get a synthesized failure (exactly one response);
 * retire/stop/shutdown never emit thread_died.
 */

import type { HubFrame } from "./protocol.ts";
import type { WorkerHandle } from "./worker-process.ts";
import type { ThreadTable } from "./thread-table.ts";
import type { InternalWaiter } from "./worker-frames.ts";

export interface DeathDeps {
  table: ThreadTable;
  internalIds: Map<string, InternalWaiter>;
  allWorkers: Set<WorkerHandle>;
  freeGrants: (worker: WorkerHandle) => void;
  failure: (id: string | undefined, command: string, error: string) => void;
  emitFrame: (frame: HubFrame) => void;
}

/** Pool.close integration: drop bookkeeping, wake internal waiters, settle. */
export function reconcileWorkerClosed(deps: {
  death: DeathDeps;
  worker: WorkerHandle;
  code: number | null;
  signal: string | null;
  workerExitTimeoutMs: number;
}): void {
  const { death, worker, code, signal, workerExitTimeoutMs } = deps;
  death.allWorkers.delete(worker);
  death.freeGrants(worker);
  if (worker.threadId !== "" && death.table.liveWorker(worker.threadId) === worker) {
    death.table.removeLive(worker.threadId);
  }
  death.table.reoccupy(worker, null);
  for (const id of worker.internalIds) {
    const key = `${worker.uid}:${id}`;
    const waiter = death.internalIds.get(key);
    death.internalIds.delete(key);
    waiter?.onClosed();
  }
  worker.internalIds.clear();
  settleClosedWorker(death, worker, closeReason({ worker, code, signal, workerExitTimeoutMs }));
}

function closeReason(deps: {
  worker: WorkerHandle;
  code: number | null;
  signal: string | null;
  workerExitTimeoutMs: number;
}): string {
  const { worker, code, signal, workerExitTimeoutMs } = deps;
  if (worker.retireIntent === "none" && worker.awaitingStart) {
    return worker.spawnError !== undefined
      ? `Worker failed to start: ${worker.spawnError}`
      : `Worker failed to start within ${workerExitTimeoutMs}ms`;
  }
  return `worker exited (code: ${String(code)}, signal: ${String(signal)})`;
}

/** Pending commands get their exactly-one synthesized failure; entries
 * transition (retire parks, abnormal deaths emit thread_died exactly once). */
function settleClosedWorker(deps: DeathDeps, worker: WorkerHandle, reason: string): void {
  const wasRetire = worker.retireIntent === "retire";
  const wasStop = worker.retireIntent === "stop";
  const wasShutdown = worker.retireIntent === "shutdown";
  const spawnTimeout =
    worker.retireIntent === "none" && worker.awaitingStart && worker.spawnError === undefined;
  if (!wasShutdown) {
    for (const [id, command] of worker.pendingIds) {
      // Responses already seen were removed from pendingIds; what remains
      // never got its exactly-one response. Spawn timeouts use the bare
      // documented message (design §2), without the "worker died" prefix.
      deps.failure(id, command, spawnTimeout ? reason : `worker died: ${reason}`);
    }
  }
  worker.pendingIds.clear();
  const entry = worker.threadId !== "" ? deps.table.entry(worker.threadId) : undefined;
  if (wasStop || wasShutdown) {
    if (entry !== undefined) deps.table.delete(worker.threadId);
    return;
  }
  if (entry === undefined) return;
  entry.state = wasRetire ? "parked" : "dead";
  entry.wake = undefined;
  entry.sessionPath = worker.sessionPath ?? entry.sessionPath;
  deps.table.enforceNonLiveCap();
  if (!wasRetire) {
    deps.emitFrame({ type: "thread_died", threadId: worker.threadId, reason });
  }
}
