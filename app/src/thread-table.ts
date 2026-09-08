/**
 * Routing table: the host-side truth for conversation state. External
 * threadId = worker sessionId (v0.3). Owns the entry map (live/parked/dead),
 * the live threadId -> worker map, cross-process session-path occupancy
 * (spawning counts as occupied), the non-live entry cap, and the table
 * re-keying driven by thread/start/resume/fork/clone responses.
 */

import { resolve as resolvePath } from "node:path";
import type { ThreadListEntry } from "./protocol.ts";
import type { WorkerHandle } from "./worker-process.ts";

const NON_LIVE_ENTRY_CAP = 1024;

export interface ThreadEntry {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
  trusted: boolean;
  state: "live" | "parked" | "dead";
  /** In-progress respawn (parked/dead -> live); concurrent senders share it. */
  wake: Promise<void> | undefined;
  /** thread/stop arrived while a wake was in flight; the wake must not
   * resurrect the entry (design §6 spawning -thread/stop-> cancelled). */
  stopRequested: boolean;
}

interface StartResponseData {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
}

interface ForkResponseData {
  threadId: string;
  previousThreadId: string;
  sessionPath: string | null;
}

export class ThreadTable {
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly workers = new Map<string, WorkerHandle>(); // live threadId -> worker
  private readonly occupiedPaths = new Map<string, WorkerHandle>(); // resolved path -> worker

  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  entry(threadId: string): ThreadEntry | undefined {
    return this.entries.get(threadId);
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  liveWorker(threadId: string): WorkerHandle | undefined {
    return this.workers.get(threadId);
  }

  /** Remove the live worker mapping (close settlement); the entry stays. */
  removeLive(threadId: string): void {
    this.workers.delete(threadId);
  }

  /** Live/parked/dead entry counts (get_host_info.threads). */
  stateCounts(): { live: number; parked: number; dead: number } {
    const counts = { live: 0, parked: 0, dead: 0 };
    for (const entry of this.list(() => false)) counts[entry.state] += 1;
    return counts;
  }

  liveCount(): number {
    return this.workers.size;
  }

  list(streamingFor: (threadId: string) => boolean): ThreadListEntry[] {
    return [...this.entries.values()].map((entry) => ({
      threadId: entry.threadId,
      cwd: entry.cwd,
      sessionPath: entry.sessionPath,
      isStreaming: entry.state === "live" ? streamingFor(entry.threadId) : false,
      state: entry.state,
    }));
  }

  /** A parked/dead entry for the same file is being replaced, not duplicated. */
  deleteNonLiveByPath(sessionPath: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.state !== "live" &&
        entry.sessionPath !== null &&
        resolvePath(entry.sessionPath) === sessionPath
      ) {
        this.entries.delete(entry.threadId);
      }
    }
  }

  /**
   * Path occupancy check with a belt beyond the occupiedPaths registry: a
   * spawning worker whose session file just appeared (persist → response
   * window, design §6 blind window) may only be known via its heartbeat.
   */
  holder(sessionPath: string, knownWorkers: Iterable<WorkerHandle>): WorkerHandle | undefined {
    const direct = this.occupiedPaths.get(sessionPath);
    if (direct !== undefined) return direct;
    for (const worker of knownWorkers) {
      if (worker.sessionPath !== null && resolvePath(worker.sessionPath) === sessionPath) {
        return worker;
      }
    }
    return undefined;
  }

  occupy(worker: WorkerHandle, path: string): void {
    worker.sessionPath = path;
    this.occupiedPaths.set(resolvePath(path), worker);
  }

  /** Move the worker's path occupancy to `path` (null = release only). */
  reoccupy(worker: WorkerHandle, path: string | null): void {
    if (worker.sessionPath !== null) {
      const resolved = resolvePath(worker.sessionPath);
      if (this.occupiedPaths.get(resolved) === worker) this.occupiedPaths.delete(resolved);
    }
    if (path !== null) this.occupy(worker, path);
    else worker.sessionPath = null;
  }

  enforceNonLiveCap(): void {
    let nonLive = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "live") nonLive++;
    }
    while (nonLive > NON_LIVE_ENTRY_CAP) {
      let evicted = false;
      for (const entry of this.entries.values()) {
        if (entry.state !== "live") {
          this.entries.delete(entry.threadId);
          nonLive--;
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  /** thread/start or thread/resume succeeded: register/update the live entry. */
  registerLive(
    worker: WorkerHandle,
    start: Record<string, unknown>,
    noteIdChange: (from: string, to: string) => void,
  ): void {
    const data = start as unknown as StartResponseData;
    if (typeof data.threadId !== "string" || typeof data.cwd !== "string") return;
    if (worker.threadId !== "" && worker.threadId !== data.threadId) {
      // Wake resumed to a different session id than parked: trust the response.
      noteIdChange(worker.threadId, data.threadId);
      this.entries.delete(worker.threadId);
      this.workers.delete(worker.threadId);
    }
    const entry: ThreadEntry = this.entries.get(data.threadId) ?? {
      threadId: data.threadId,
      cwd: data.cwd,
      sessionPath: data.sessionPath,
      trusted: worker.trusted,
      state: "live",
      wake: undefined,
      stopRequested: false,
    };
    entry.threadId = data.threadId;
    entry.cwd = data.cwd;
    entry.sessionPath = data.sessionPath;
    entry.trusted = worker.trusted;
    entry.state = "live";
    entry.wake = undefined;
    // stopRequested survives reuse: a thread/stop racing this wake lands on
    // this very object (registerLive runs before doWake's post-check).
    this.entries.set(data.threadId, entry);
    worker.threadId = data.threadId;
    this.workers.set(data.threadId, worker);
    worker.awaitingStart = false;
    this.reoccupy(worker, data.sessionPath);
  }

  /** fork/clone succeeded: re-key entry and worker under the new session id. */
  rekeyFork(worker: WorkerHandle, rawFork: Record<string, unknown>): void {
    const fork = rawFork as unknown as ForkResponseData;
    if (
      typeof fork.threadId !== "string" ||
      typeof fork.previousThreadId !== "string" ||
      fork.threadId === fork.previousThreadId
    ) {
      return; // cancelled fork: ids equal, nothing re-keys
    }
    const entry = this.entries.get(fork.previousThreadId);
    if (entry !== undefined) {
      this.entries.delete(fork.previousThreadId);
      entry.threadId = fork.threadId;
      entry.sessionPath = fork.sessionPath;
      this.entries.set(fork.threadId, entry);
    }
    if (this.workers.get(fork.previousThreadId) === worker) {
      this.workers.delete(fork.previousThreadId);
      this.workers.set(fork.threadId, worker);
      worker.threadId = fork.threadId;
    }
    this.reoccupy(worker, fork.sessionPath);
  }

  /** Wake resumed under a different session id (lazy-persist sessions get a
   * fresh id): drop the stale parked entry so it cannot wedge the same
   * session path; sidecar rules follow the id (warn on copy failure). */
  rekeyWake(
    worker: WorkerHandle,
    previousThreadId: string,
    sidecar: {
      warn: (text: string) => void;
      copy: (from: string, to: string) => boolean;
    },
  ): void {
    const id = worker.threadId;
    sidecar.warn(
      `pai-cli worker resumed to a different session id (${previousThreadId} -> ${id})\n`,
    );
    if (!sidecar.copy(previousThreadId, id)) {
      sidecar.warn(
        "pai-cli could not copy permission rules across the id change; the thread falls back to the global rules\n",
      );
    }
    this.delete(previousThreadId);
  }
}
