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
  /** v0.12 sandbox posture from the admitting command (undefined = infer). */
  posture: "strict" | "balanced" | "open" | undefined;
  state: "live" | "parked" | "dead";
  /** v0.13: skip the idle retire for this entry's live worker (thread/set_keepalive).
   * Not persisted — the client's registry is the durable truth. */
  keepalive: boolean;
  /** In-progress respawn (parked/dead -> live); concurrent senders share it. */
  wake: Promise<void> | undefined;
  /** thread/stop arrived while a wake was in flight; the wake must not
   * resurrect the entry (design §6 spawning -thread/stop-> cancelled). */
  stopRequested: boolean;
}

/** v0.13 observability projection for one live worker (thread/list rows). */
export interface LiveWorkerFacts {
  isStreaming: boolean;
  idleMs: number;
  subagents: number;
  rssBytes: number | null;
}

/** Non-live rows report a zeroed projection (no worker exists to ask). */
export const IDLE_WORKER_FACTS: LiveWorkerFacts = {
  isStreaming: false,
  idleMs: 0,
  subagents: 0,
  rssBytes: null,
};

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
    for (const entry of this.entries.values()) counts[entry.state] += 1;
    return counts;
  }

  liveCount(): number {
    return this.workers.size;
  }

  /** v0.13: set the keepalive flag; false return = unknown thread (the
   * command answers a failure on it). */
  setKeepalive(threadId: string, keepalive: boolean): boolean {
    const entry = this.entries.get(threadId);
    if (entry === undefined) return false;
    entry.keepalive = keepalive;
    return true;
  }

  /** v0.13 observability projection of the live worker (thread/list rows);
   * the table owns the live-worker map, so the projection lives here. */
  liveFacts(threadId: string): LiveWorkerFacts {
    const worker = this.workers.get(threadId);
    if (worker === undefined) return IDLE_WORKER_FACTS;
    return {
      isStreaming: worker.streaming,
      idleMs: worker.idleMs,
      subagents: worker.subagents,
      rssBytes: worker.rssBytes,
    };
  }

  list(factsFor: (threadId: string) => LiveWorkerFacts): ThreadListEntry[] {
    return [...this.entries.values()].map((entry) => ({
      threadId: entry.threadId,
      cwd: entry.cwd,
      sessionPath: entry.sessionPath,
      state: entry.state,
      ...(entry.state === "live" ? factsFor(entry.threadId) : IDLE_WORKER_FACTS),
      keepalive: entry.keepalive,
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

  /** thread/register (v0.12): first non-live entry matching the resolved
   * session path (register is idempotent on it). */
  nonLiveByPath(sessionPath: string): ThreadEntry | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.state !== "live" &&
        entry.sessionPath !== null &&
        resolvePath(entry.sessionPath) === sessionPath
      ) {
        return entry;
      }
    }
    return undefined;
  }

  /** thread/register: admit a session file as a parked entry (no worker).
   * Never overwrites an existing entry — callers resolve idempotency first. */
  registerParked(spec: {
    threadId: string;
    cwd: string;
    sessionPath: string;
    trusted: boolean;
  }): void {
    this.entries.set(spec.threadId, {
      threadId: spec.threadId,
      cwd: spec.cwd,
      sessionPath: spec.sessionPath,
      trusted: spec.trusted,
      posture: undefined,
      state: "parked",
      keepalive: false,
      wake: undefined,
      stopRequested: false,
    });
    this.enforceNonLiveCap();
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
      posture: worker.posture,
      state: "live",
      // keepalive survives the wake cycle only through entry reuse (the flag
      // is client-owned); a brand-new entry starts unmarked.
      keepalive: false,
      wake: undefined,
      stopRequested: false,
    };
    entry.threadId = data.threadId;
    entry.cwd = data.cwd;
    entry.sessionPath = data.sessionPath;
    entry.trusted = worker.trusted;
    entry.posture = worker.posture;
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
      // A fork is a new conversation: keepalive is client-owned per thread and
      // must not silently carry over (the client re-asserts if it wants it).
      entry.keepalive = false;
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
