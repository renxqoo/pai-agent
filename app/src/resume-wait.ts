/**
 * Internal thread/resume delivery + exactly-one internal response wait
 * (extracted from worker-pool.ts, sandbox v2 W4: the pool hit the size
 * cap). Failure path releases occupancy, marks the entry dead, and kills
 * the worker.
 */

import type { InternalWaiter } from "./worker-frames.ts";
import type { ThreadEntry } from "./thread-table.ts";
import type { WorkerHandle } from "./worker-process.ts";

export async function resumeAndWait(deps: {
  worker: WorkerHandle;
  entry: ThreadEntry;
  sessionPath: string;
  registerInternal: (waiter: InternalWaiter) => string;
  internalIds: Map<string, InternalWaiter>;
  onFailedResume: () => Promise<void>;
}): Promise<void> {
  const { worker, entry } = deps;
  const forget = (id: string): void => {
    deps.internalIds.delete(`${worker.uid}:${id}`);
    worker.internalIds.delete(id);
  };
  try {
    await new Promise<void>((done, refuse) => {
      const id = deps.registerInternal({
        onResponse: (frame) => {
          forget(id);
          if (frame["success"] === true) done();
          else refuse(new Error(String(frame["error"] ?? "resume failed")));
        },
        onClosed: () => {
          forget(id);
          refuse(new Error("worker died while resuming"));
        },
      });
      void worker
        .writeLine(
          JSON.stringify({
            type: "thread/resume",
            sessionPath: deps.sessionPath,
            cwd: entry.cwd,
            trusted: entry.trusted,
            ...(entry.posture !== undefined ? { sandboxPosture: entry.posture } : {}),
            id,
          }),
        )
        .catch((error: unknown) => {
          forget(id);
          refuse(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } catch (error) {
    await deps.onFailedResume();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
