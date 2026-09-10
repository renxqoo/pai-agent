/**
 * thread/register admission (v0.12, docs/plans/2026-09-10-parked-read-history.md):
 * table-only admission of a session file as a parked entry — no worker
 * spawn. The host handler owns the path fence and the header parse; this
 * resolves occupancy and idempotency against live state. Extracted from
 * worker-pool.ts (one verb, one file); state stays in the table.
 */

import type { ThreadTable } from "./thread-table.ts";
import type { WorkerHandle } from "./worker-process.ts";

export interface RegisterOps {
  table: ThreadTable;
  workers(): WorkerHandle[];
}

export type RegisterOutcome =
  | { ok: true; data: { threadId: string; cwd: string; sessionPath: string } }
  | { ok: false; error: string };

/** Occupancy first (a live writer forbids admission), then idempotency on
 * thread id and resolved session path, then the new parked entry. */
export function registerParkedAdmission(
  ops: RegisterOps,
  spec: { sessionPath: string; threadId: string; cwd: string; trusted: boolean },
): RegisterOutcome {
  const holder = ops.table.holder(spec.sessionPath, ops.workers());
  if (holder !== undefined) {
    // holder.threadId is "" while an in-flight wake is still spawning —
    // the worker uid keeps the diagnostic non-empty there.
    const who =
      holder.threadId.length > 0 ? `threadId: ${holder.threadId}` : `worker ${holder.uid}`;
    return {
      ok: false,
      error: `Session already open (${who}); two writers would corrupt the session file`,
    };
  }
  const byId = ops.table.entry(spec.threadId);
  if (byId !== undefined) {
    // Idempotent on the entry — and repairing: an entry whose sessionPath
    // is null (worker died between persist and first heartbeat) gets the
    // on-disk path written back instead of a hollow idempotent echo.
    if (byId.sessionPath === null) byId.sessionPath = spec.sessionPath;
    return {
      ok: true,
      data: { threadId: byId.threadId, cwd: byId.cwd, sessionPath: byId.sessionPath },
    };
  }
  const byPath = ops.table.nonLiveByPath(spec.sessionPath);
  if (byPath !== undefined) {
    // nonLiveByPath only matches entries whose sessionPath resolved to this
    // path — never null here; the guard keeps the type honest.
    const existingPath = byPath.sessionPath ?? spec.sessionPath;
    return {
      ok: true,
      data: { threadId: byPath.threadId, cwd: byPath.cwd, sessionPath: existingPath },
    };
  }
  ops.table.registerParked(spec);
  return {
    ok: true,
    data: { threadId: spec.threadId, cwd: spec.cwd, sessionPath: spec.sessionPath },
  };
}
