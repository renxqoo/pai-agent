/**
 * Thread admission (design.md migration §5): thread/start and thread/resume
 * spawning — budget check, session-path occupancy claim (spawning counts as
 * occupied), and first-command delivery. Extracted from worker-pool.ts (one
 * verb, one file); the pool passes itself as the ops object, so all state
 * (table, workers, budget) still lives in exactly one place.
 */

import { resolve as resolvePath } from "node:path";
import type { SessionModel } from "./protocol.ts";
import type { RetireIntent, WorkerHandle } from "./worker-process.ts";
import type { ThreadTable } from "./thread-table.ts";

export interface AdmissionOps {
  table: ThreadTable;
  workers(): WorkerHandle[];
  spawnWorker(trusted: boolean, posture: "strict" | "balanced" | "open" | undefined): WorkerHandle;
  killWorker(worker: WorkerHandle, intent: RetireIntent): Promise<void>;
  deliverCommand(command: {
    worker: WorkerHandle;
    id: string | undefined;
    command: string;
    line: string;
  }): Promise<void>;
  rejectOverBudget(id: string | undefined, command: string): boolean;
  overBudget(): boolean;
  failure(id: string | undefined, command: string, error: string): void;
}

/** thread/start: spawn a worker and send the internal start (model resolved by the host). */
/** v0.12 posture param validation: bad enums fail honestly (review R6 —
 * a typo'd posture must not silently fall back to balanced and bypass the
 * untrusted→strict inference). */
function validPosture(value: unknown): value is "strict" | "balanced" | "open" {
  return value === "strict" || value === "balanced" || value === "open";
}

export async function startThreadAdmission(
  pool: AdmissionOps,
  cmd: {
    id?: string;
    cwd?: string;
    trusted?: boolean;
    sandboxPosture?: "strict" | "balanced" | "open";
  },
  model?: SessionModel,
): Promise<void> {
  if (cmd.sandboxPosture !== undefined && !validPosture(cmd.sandboxPosture)) {
    pool.failure(cmd.id, "thread/start", "sandboxPosture must be one of strict|balanced|open");
    return;
  }
  if (pool.rejectOverBudget(cmd.id, "thread/start")) return;
  const worker = pool.spawnWorker(cmd.trusted === true, cmd.sandboxPosture);
  if (pool.overBudget()) {
    // A concurrent start took the last slot while this worker spawned
    // (this spawn now counts itself). Exactly maxThreads survive.
    await pool.killWorker(worker, "stop");
    pool.rejectOverBudget(cmd.id, "thread/start");
    return;
  }
  const line = JSON.stringify({
    type: "thread/start",
    cwd: cmd.cwd ?? process.cwd(),
    trusted: cmd.trusted === true,
    ...(cmd.sandboxPosture !== undefined ? { sandboxPosture: cmd.sandboxPosture } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cmd.id !== undefined ? { id: cmd.id } : {}),
  });
  await pool.deliverCommand({ worker, id: cmd.id, command: "thread/start", line });
}

/** thread/resume: claim the session path (spawning counts as occupied), then spawn. */
export async function resumeThreadAdmission(
  pool: AdmissionOps,
  cmd: {
    id?: string;
    sessionPath: string;
    cwd?: string;
    trusted?: boolean;
    sandboxPosture?: "strict" | "balanced" | "open";
  },
): Promise<void> {
  const sessionPath = resolvePath(cmd.sessionPath);
  const holder = await settledHolderOf(pool, sessionPath);
  if (holder !== undefined) {
    pool.failure(
      cmd.id,
      "thread/resume",
      `Session already open (threadId: ${holder.threadId}); two writers would corrupt the session file`,
    );
    return;
  }
  if (cmd.sandboxPosture !== undefined && !validPosture(cmd.sandboxPosture)) {
    pool.failure(cmd.id, "thread/resume", "sandboxPosture must be one of strict|balanced|open");
    return;
  }
  if (pool.rejectOverBudget(cmd.id, "thread/resume")) return;
  pool.table.deleteNonLiveByPath(sessionPath);
  const worker = pool.spawnWorker(cmd.trusted === true, cmd.sandboxPosture);
  if (pool.table.holder(sessionPath, pool.workers()) !== undefined || pool.overBudget()) {
    await pool.killWorker(worker, "stop");
    pool.failure(
      cmd.id,
      "thread/resume",
      "Session already open in another conversation; two writers would corrupt the session file",
    );
    return;
  }
  pool.table.occupy(worker, sessionPath);
  const line = JSON.stringify({
    type: "thread/resume",
    sessionPath,
    ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
    trusted: cmd.trusted === true,
    ...(cmd.sandboxPosture !== undefined ? { sandboxPosture: cmd.sandboxPosture } : {}),
    ...(cmd.id !== undefined ? { id: cmd.id } : {}),
  });
  await pool.deliverCommand({ worker, id: cmd.id, command: "thread/resume", line });
}

/**
 * Path-occupancy lookup that first waits out a worker still releasing the
 * path: thread/stop is acknowledged before the worker closes (the response
 * rides ahead of the EOF), so an immediate resume of the same path must
 * wait for that close instead of reporting the thread's own stopping
 * worker as a conflict. Bounded: a wedged shutdown (worker alive but never
 * exiting) is force-closed via killWorker — resume must never become a
 * permanently unanswered command.
 */
export async function settledHolderOf(
  pool: AdmissionOps,
  sessionPath: string,
): Promise<WorkerHandle | undefined> {
  for (;;) {
    const holder = pool.table.holder(sessionPath, pool.workers());
    if (holder === undefined || !holder.retiring) return holder;
    await pool.killWorker(holder, holder.retireIntent === "none" ? "stop" : holder.retireIntent);
  }
}
