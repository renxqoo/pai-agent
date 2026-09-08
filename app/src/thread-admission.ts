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
  spawnWorker(trusted: boolean): WorkerHandle;
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
export async function startThreadAdmission(
  pool: AdmissionOps,
  cmd: { id?: string; cwd?: string; trusted?: boolean },
  model?: SessionModel,
): Promise<void> {
  if (pool.rejectOverBudget(cmd.id, "thread/start")) return;
  const worker = pool.spawnWorker(cmd.trusted === true);
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
    ...(model !== undefined ? { model } : {}),
    ...(cmd.id !== undefined ? { id: cmd.id } : {}),
  });
  await pool.deliverCommand({ worker, id: cmd.id, command: "thread/start", line });
}

/** thread/resume: claim the session path (spawning counts as occupied), then spawn. */
export async function resumeThreadAdmission(
  pool: AdmissionOps,
  cmd: { id?: string; sessionPath: string; cwd?: string; trusted?: boolean },
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
  if (pool.rejectOverBudget(cmd.id, "thread/resume")) return;
  pool.table.deleteNonLiveByPath(sessionPath);
  const worker = pool.spawnWorker(cmd.trusted === true);
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
