/**
 * thread/retire settlement (v0.13): the manual counterpart of the idle sweep —
 * park the entry (session file kept) instead of thread/stop's dispose.
 * Idempotent over all three entry states; a stop racing the retire wins
 * (deletion has the stronger intent). Extracted per one-verb-one-file.
 */

import { retireWorker } from "./thread-retire.ts";
import type { ThreadEntry, ThreadTable } from "./thread-table.ts";
import type { WorkerHandle } from "./worker-process.ts";

export interface RetireOps {
  table: ThreadTable;
  emitFrame: (frame: {
    type: "response";
    id?: string;
    command: string;
    success: boolean;
    error?: string;
  }) => void;
  liveWorker(threadId: string): WorkerHandle | undefined;
  armTeardownDeadline(worker: WorkerHandle): void;
}

export function retireThreadSettlement(
  pool: RetireOps,
  cmd: { threadId: string; id?: string; cmdType: string },
): void {
  const { threadId, id: cmdId, cmdType } = cmd;
  const entry = pool.table.entry(threadId);
  // Idempotent (aligned with thread/stop): unknown threads ack — parked/dead
  // already describe the post-retire state. A wake in flight is NOT a stable
  // state though: mark retireRequested so the revived worker is retired the
  // moment the wake lands (the stop-raced-wake mirror, design §6).
  if (entry === undefined) {
    ackRetire(pool, cmdId, cmdType);
    return;
  }
  if (entry.state !== "live") {
    retireOnWakeLanding(pool, entry, threadId);
    ackRetire(pool, cmdId, cmdType);
    return;
  }
  const worker = pool.liveWorker(threadId);
  if (worker === undefined) {
    // ensureAwake raced a death; its close handling settles the entry.
    ackRetire(pool, cmdId, cmdType);
    return;
  }
  if (worker.retiring) {
    // In-flight stop (dispose) wins; an in-flight idle retire is already
    // parking — upgrade its reason so the client sees the manual intent.
    if (worker.retireIntent === "retire") worker.retireReason = "manual";
    ackRetire(pool, cmdId, cmdType);
    return;
  }
  if (worker.sessionPath === null) {
    // Lazy-persist session (no file yet): parking it would wedge the entry
    // forever — wake requires a sessionPath. Refuse; the client retries after
    // the first message persists (or stops the thread instead).
    pool.emitFrame({
      type: "response",
      id: cmdId,
      command: cmdType,
      success: false,
      error: "Session not persisted yet",
    });
    return;
  }
  retireWorker(pool, worker, "manual");
  ackRetire(pool, cmdId, cmdType);
}

function ackRetire(pool: RetireOps, cmdId: string | undefined, cmdType: string): void {
  pool.emitFrame({ type: "response", id: cmdId, command: cmdType, success: true });
}

/** A wake in flight is not a stable state: park it the moment the revived
 * worker lands (the stop-raced-wake mirror, design §6). */
function retireOnWakeLanding(pool: RetireOps, entry: ThreadEntry, threadId: string): void {
  if (entry.wake === undefined) return;
  void entry.wake
    .catch(() => {})
    .finally(() => {
      const landed = pool.liveWorker(threadId);
      if (landed !== undefined) retireWorker(pool, landed, "manual");
    });
}
